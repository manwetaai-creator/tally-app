"""Azure Blob Storage for the Windows installer.

Auth options (set one):
  * AZURE_STORAGE_CONNECTION_STRING            - simplest; SAS links are signed with the account key.
  * AZURE_STORAGE_ACCOUNT_URL + managed identity - recommended on App Service. The identity needs
    'Storage Blob Data Contributor' (upload) and 'Storage Blob Delegator' (to sign SAS links).
"""
import logging
from datetime import timedelta
from typing import BinaryIO
from urllib.parse import quote

from .config import get_settings
from .models import utcnow

log = logging.getLogger("manweta.blob")
SCHEME = "azure-blob://"


def configured() -> bool:
    s = get_settings()
    return bool(s.azure_storage_connection_string or s.azure_storage_account_url)


def _service():
    from azure.storage.blob import BlobServiceClient

    s = get_settings()
    if s.azure_storage_connection_string:
        return BlobServiceClient.from_connection_string(s.azure_storage_connection_string)
    from azure.identity import DefaultAzureCredential

    return BlobServiceClient(account_url=s.azure_storage_account_url, credential=DefaultAzureCredential())


def upload(fileobj: BinaryIO, blob_name: str) -> str:
    """Upload and return the 'azure-blob://container/blob' reference stored in the DB."""
    from azure.storage.blob import ContentSettings

    container = get_settings().azure_storage_container
    svc = _service()
    cc = svc.get_container_client(container)
    try:
        cc.create_container()  # private by default; ignore if it already exists / no permission
    except Exception:  # noqa: BLE001
        pass
    fileobj.seek(0)
    cc.upload_blob(
        name=blob_name,
        data=fileobj,
        overwrite=True,
        max_concurrency=4,
        content_settings=ContentSettings(content_type="application/octet-stream"),
    )
    return f"{SCHEME}{container}/{blob_name}"


def sas_url(ref: str, download_name: str) -> str:
    """Short-lived read-only link for a stored blob reference."""
    from azure.storage.blob import BlobSasPermissions, generate_blob_sas

    s = get_settings()
    container, _, blob_name = ref[len(SCHEME):].partition("/")
    svc = _service()
    now = utcnow()
    expiry = now + timedelta(minutes=s.sas_ttl_minutes)
    common = dict(
        account_name=svc.account_name,
        container_name=container,
        blob_name=blob_name,
        permission=BlobSasPermissions(read=True),
        expiry=expiry,
        content_disposition=f'attachment; filename="{download_name}"',
    )
    account_key = getattr(svc.credential, "account_key", None)
    if account_key:
        sas = generate_blob_sas(account_key=account_key, **common)
    else:
        udk = svc.get_user_delegation_key(now - timedelta(minutes=1), expiry)
        sas = generate_blob_sas(user_delegation_key=udk, **common)
    return f"{svc.url.rstrip('/')}/{container}/{quote(blob_name)}?{sas}"


def open_stream(ref: str):
    """Open an Azure blob reference for streaming through the app."""
    container, _, blob_name = ref[len(SCHEME):].partition("/")
    client = _service().get_blob_client(container=container, blob=blob_name)
    size = client.get_blob_properties().size
    return client.download_blob().chunks(), size
