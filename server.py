#!/usr/bin/env python3
"""Entry point. `python server.py` and it serves."""
import uvicorn
from latina import config

if __name__ == "__main__":
    print(f"[latina] http://{config.HOST}:{config.PORT} · "
          f"voice={config.DEFAULT_VOICE} · model={config.MODEL_ID}", flush=True)
    uvicorn.run("latina.api:app", host=config.HOST, port=config.PORT,
                log_level="info", workers=1)   # one worker: one model in memory
