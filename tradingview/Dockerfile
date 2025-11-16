# It must use alpine3.12; otherwise, it won't work in Raspberry Pi 32bit.
FROM python:3-alpine3.12

WORKDIR /app

COPY requirements.txt requirements.txt

# Explanation: upgrade pip/setuptools/wheel to avoid sdist TOML parse error, then install deps.
# Also optionally force a newer MarkupSafe with a prebuilt wheel.
RUN python -m pip install --upgrade pip setuptools wheel && \
    pip install --no-cache-dir markupsafe==2.1.5 && \
    pip install --no-cache-dir -r requirements.txt

COPY . .

ENV FLASK_APP=main.py
ENV FLASK_ENV=production

CMD [ "python", "main.py"]

EXPOSE 8080
