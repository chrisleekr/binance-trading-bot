FROM ubuntu:20.04

RUN apt update && apt upgrade -y
RUN DEBIAN_FRONTEND="noninteractive" apt install firefox firefox-geckodriver python3 python3-pip -y

WORKDIR /srv
COPY requirements.txt ./
RUN pip3 install -r requirements.txt && rm requirements.txt
COPY ./src/* ./
CMD ["python3", "main.py"]
