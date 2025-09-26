import os
from together import Together
from transformers import AutoTokenizer

client = Together(api_key=os.environ.get("TOGETHER_API_KEY"))

import json

file_resp = client.files.upload(file="dataset-train.jsonl", check=True)
file_eval_resp = client.files.upload(file="dataset-test.jsonl", check=True)

response = client.fine_tuning.create(
    training_file=file_resp.id,
    validation_file=file_eval_resp.id,
    model="openai/gpt-oss-20b",
    n_evals=15,
    n_epochs=3,
    n_checkpoints=1,
    lora=True,
)

print(response)