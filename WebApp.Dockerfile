# ── Stage 1: Build Frontend ──────────────────────────────────────────────────
FROM node:20-alpine AS frontend

RUN mkdir -p /home/node/app
WORKDIR /home/node/app

COPY ./frontend/package*.json ./frontend/
RUN cd frontend && npm ci

COPY ./frontend/ ./frontend/
RUN cd frontend && NODE_OPTIONS=--max_old_space_size=8192 npm run build

# ── Stage 2: Python Backend ─────────────────────────────────────────────────
FROM python:3.11-alpine

RUN apk add --no-cache build-base libffi-dev openssl-dev curl

COPY requirements.txt /usr/src/app/
RUN pip install --no-cache-dir -r /usr/src/app/requirements.txt

COPY . /usr/src/app/
COPY --from=frontend /home/node/app/static /usr/src/app/static/

WORKDIR /usr/src/app
EXPOSE 80

CMD ["gunicorn", "-b", "0.0.0.0:80", "app:app"]
