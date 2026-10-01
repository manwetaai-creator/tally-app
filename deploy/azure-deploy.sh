#!/usr/bin/env bash

# One-shot (re-runnable) Azure setup:
# RG, ACR, Storage, App Service plan + Web App for Containers.
#
# Prerequisites:
#   1. az login
#   2. DATABASE_URL exported
#
# Example:
#   export DATABASE_URL="postgresql://..."
#   bash deploy.sh
#
# IMPORTANT:
# This script is designed to work from Git Bash on Windows.

set -euo pipefail


# ============================================================
# Required environment variable
# ============================================================

: "${DATABASE_URL:?export DATABASE_URL=<Neon pooled connection string> first}"


# ============================================================
# Configuration
# ============================================================

SUFFIX="${SUFFIX:-$(printf '%s' "$(az account show --query id -o tsv)" | cut -c1-6)}"

RG="${RG:-manweta-rg}"
LOCATION="${LOCATION:-centralindia}"

ACR="${ACR:-manwetaacr${SUFFIX}}"
STORAGE="${STORAGE:-manwetastore${SUFFIX}}"
CONTAINER="${CONTAINER:-installers}"

PLAN="${PLAN:-manweta-plan}"
SKU="${SKU:-B1}"

APP="${APP:-manweta-app-${SUFFIX}}"

TAG="${TAG:-$(git rev-parse --short HEAD 2>/dev/null || date +%Y%m%d%H%M%S)}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SECRETS_FILE="$SCRIPT_DIR/.secrets.env"


# ============================================================
# Generate persistent encryption secret
# ============================================================

# IMPORTANT:
# Keep this file safe.
# Losing ENCRYPTION_KEY means existing WhatsApp connections
# may need to be reconnected.

if [[ ! -f "$SECRETS_FILE" ]]; then
    echo "ENCRYPTION_KEY=$(openssl rand -base64 32 | tr '+/' '-_')" > "$SECRETS_FILE"
fi

# shellcheck disable=SC1090
source "$SECRETS_FILE"


# ============================================================
# Display deployment information
# ============================================================

echo
echo "============================================================"
echo "Manweta AI - Azure Deployment"
echo "============================================================"
echo
echo "Subscription:"
az account show \
    --query "{name:name,id:id,tenantId:tenantId}" \
    -o table

echo
echo "Configuration:"
echo "  Resource Group : $RG"
echo "  Location       : $LOCATION"
echo "  ACR            : $ACR"
echo "  Storage        : $STORAGE"
echo "  Container      : $CONTAINER"
echo "  App Service    : $APP"
echo "  Plan           : $PLAN"
echo "  SKU            : $SKU"
echo "  Image          : manweta:$TAG"
echo


# ============================================================
# Resource Group
# ============================================================

echo "============================================================"
echo "==> Resource group"
echo "============================================================"

az group create \
    --name "$RG" \
    --location "$LOCATION" \
    --output none


# ============================================================
# Azure Container Registry
# ============================================================

echo "============================================================"
echo "==> Azure Container Registry"
echo "============================================================"

az acr create \
    --resource-group "$RG" \
    --name "$ACR" \
    --sku Basic \
    --admin-enabled false \
    --output none


# ============================================================
# Storage Account
# ============================================================

echo "============================================================"
echo "==> Storage account"
echo "============================================================"

az storage account create \
    --resource-group "$RG" \
    --name "$STORAGE" \
    --location "$LOCATION" \
    --sku Standard_LRS \
    --kind StorageV2 \
    --allow-blob-public-access false \
    --min-tls-version TLS1_2 \
    --output none


echo "==> Getting storage account key"

STORAGE_KEY=$(az storage account keys list \
    --resource-group "$RG" \
    --account-name "$STORAGE" \
    --query '[0].value' \
    --output tsv)


echo "==> Creating private blob container"

az storage container create \
    --account-name "$STORAGE" \
    --account-key "$STORAGE_KEY" \
    --name "$CONTAINER" \
    --public-access off \
    --output none


# ============================================================
# Build Docker image directly in ACR
# ============================================================

echo "============================================================"
echo "==> Building Docker image in Azure Container Registry"
echo "============================================================"

echo
echo "Image:"
echo "$ACR.azurecr.io/manweta:$TAG"
echo

az acr build \
    --registry "$ACR" \
    --image "manweta:$TAG" \
    "$SCRIPT_DIR/.."


# ============================================================
# App Service Plan
# ============================================================

echo "============================================================"
echo "==> App Service plan"
echo "============================================================"

az appservice plan create \
    --resource-group "$RG" \
    --name "$PLAN" \
    --is-linux \
    --sku "$SKU" \
    --output none


# ============================================================
# Web App
# ============================================================

echo "============================================================"
echo "==> Creating Web App"
echo "============================================================"

# IMPORTANT:
#
# DO NOT use:
#
#   $ACR.azurecr.io/manweta:$TAG
#
# here because --container-registry-url already specifies
# the registry.
#
# Correct:
#
#   --container-image-name "manweta:$TAG"
#
# This prevents Azure from creating:
#
#   ACR.azurecr.io/ACR.azurecr.io/manweta:TAG
#

az webapp create \
    --resource-group "$RG" \
    --plan "$PLAN" \
    --name "$APP" \
    --container-image-name "manweta:$TAG" \
    --container-registry-url "https://$ACR.azurecr.io" \
    --output none


# ============================================================
# Managed Identity
# ============================================================

echo "============================================================"
echo "==> Assigning managed identity"
echo "============================================================"

PRINCIPAL=$(az webapp identity assign \
    --resource-group "$RG" \
    --name "$APP" \
    --query principalId \
    --output tsv)

echo
echo "Managed Identity Principal ID:"
echo "$PRINCIPAL"
echo


# ============================================================
# Get resource IDs
# ============================================================

echo "============================================================"
echo "==> Getting Azure resource IDs"
echo "============================================================"

ACR_ID=$(az acr show \
    --resource-group "$RG" \
    --name "$ACR" \
    --query id \
    --output tsv)

STORAGE_ID=$(az storage account show \
    --resource-group "$RG" \
    --name "$STORAGE" \
    --query id \
    --output tsv)


# ============================================================
# Grant ACR Pull permission
# ============================================================

echo "============================================================"
echo "==> Granting AcrPull permission"
echo "============================================================"

az role assignment create \
    --assignee-object-id "$PRINCIPAL" \
    --assignee-principal-type ServicePrincipal \
    --role AcrPull \
    --scope "$ACR_ID" \
    --output none || true


# ============================================================
# Grant Storage permissions
# ============================================================

echo "============================================================"
echo "==> Granting Storage permissions"
echo "============================================================"

for ROLE in \
    "Storage Blob Data Contributor" \
    "Storage Blob Delegator"
do

    az role assignment create \
        --assignee-object-id "$PRINCIPAL" \
        --assignee-principal-type ServicePrincipal \
        --role "$ROLE" \
        --scope "$STORAGE_ID" \
        --output none || true

done


# ============================================================
# Configure Web App
# ============================================================

echo "============================================================"
echo "==> Configuring Web App"
echo "============================================================"

# IMPORTANT:
#
# We intentionally DO NOT use:
#
#   az resource update --ids "/subscriptions/..."
#
# because Git Bash on Windows can convert the Azure resource
# ID into:
#
#   C:/Program Files/Git/subscriptions/...
#
# Instead, use az webapp config set.

az webapp config set \
    --resource-group "$RG" \
    --name "$APP" \
    --always-on true \
    --generic-configurations \
    '{"acrUseManagedIdentityCreds":true,"healthCheckPath":"/health"}' \
    --output none


# ============================================================
# App Settings
# ============================================================

echo "============================================================"
echo "==> Configuring application settings"
echo "============================================================"

az webapp config appsettings set \
    --resource-group "$RG" \
    --name "$APP" \
    --output none \
    --settings \
    WEBSITES_PORT=8000 \
    WEBSITES_ENABLE_APP_SERVICE_STORAGE=false \
    DATABASE_URL="$DATABASE_URL" \
    ENCRYPTION_KEY="$ENCRYPTION_KEY" \
    PUBLIC_BASE_URL="https://$APP.azurewebsites.net" \
    AZURE_STORAGE_ACCOUNT_URL="https://$STORAGE.blob.core.windows.net" \
    AZURE_STORAGE_CONTAINER="$CONTAINER" \
    SEED_DEMO_DATA="${SEED_DEMO_DATA:-false}" \
    INSECURE_PASSWORD_RESET="${INSECURE_PASSWORD_RESET:-true}" \
    INSTALLER_ADMIN_EMAILS="${INSTALLER_ADMIN_EMAILS:-}" \
    META_APP_ID="${META_APP_ID:-}" \
    META_APP_SECRET="${META_APP_SECRET:-}" \
    META_EMBEDDED_SIGNUP_CONFIG_ID="${META_EMBEDDED_SIGNUP_CONFIG_ID:-}" \
    META_WEBHOOK_VERIFY_TOKEN="${META_WEBHOOK_VERIFY_TOKEN:-verify-me}"


# ============================================================
# Restart Web App
# ============================================================

echo "============================================================"
echo "==> Restarting Web App"
echo "============================================================"

az webapp restart \
    --resource-group "$RG" \
    --name "$APP"


# ============================================================
# Deployment complete
# ============================================================

echo
echo "============================================================"
echo "DEPLOYMENT COMPLETE"
echo "============================================================"
echo
echo "Application:"
echo "https://$APP.azurewebsites.net"
echo
echo "Health:"
echo "https://$APP.azurewebsites.net/health"
echo
echo "WhatsApp webhook:"
echo "https://$APP.azurewebsites.net/api/v1/whatsapp/webhook"
echo
echo "Container image:"
echo "$ACR.azurecr.io/manweta:$TAG"
echo
echo "Resource Group:"
echo "$RG"
echo
echo "ACR:"
echo "$ACR"
echo
echo "Storage:"
echo "$STORAGE"
echo
echo "============================================================"
echo "Next deployments:"
echo "============================================================"
echo
echo "Set TAG and re-run this script, or use:"
echo ".github/workflows/deploy-azure.yml"
echo