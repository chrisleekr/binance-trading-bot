# It must use alpine3.12; otherwise, it won't work in Raspberry Pi 32bit.
FROM python:3-alpine3.12

WORKDIR /app

COPY requirements.txt requirements.txt

RUN pip install -r requirements.txt

COPY . .

ENV FLASK_APP=main.py
ENV FLASK_ENV=production

CMD [ "python", "main.py"]

EXPOSE 8080
