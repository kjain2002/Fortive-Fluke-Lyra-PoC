#!/bin/sh
echo "Starting Hierarchical Search Chatbot..."
python -m gunicorn app:app
