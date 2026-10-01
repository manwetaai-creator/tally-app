FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /srv

COPY requirements.txt .
RUN pip install -r requirements.txt

COPY app ./app
COPY static ./static

RUN useradd -m appuser && chown -R appuser /srv
USER appuser

# Azure App Service reads WEBSITES_PORT; keep it in sync with this value.
ENV PORT=8000
EXPOSE 8000

# gunicorn + uvicorn workers. --forwarded-allow-ips so request.url.scheme is https behind App Service's front end.
CMD ["sh", "-c", "exec gunicorn app.main:app -k uvicorn.workers.UvicornWorker -w ${WEB_CONCURRENCY:-2} -b 0.0.0.0:${PORT} --timeout 120 --forwarded-allow-ips='*' --access-logfile -"]
