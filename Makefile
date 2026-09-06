# Discoverable commands. `make` on its own prints them.
.DEFAULT_GOAL := help
.PHONY: help setup run bg test stop docker clean

help:  ## show this
	@grep -E '^[a-z-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  make %-8s %s\n", $$1, $$2}'

setup:  ## create .venv and install (start.sh does this too)
	./start.sh --setup-only 2>/dev/null || true

run:  ## start in the foreground; ready when it prints "warmed up"
	./start.sh

bg:  ## start in the background and wait until it is actually ready
	@rm -f latina.log
	@nohup ./start.sh > latina.log 2>&1 &
	@echo "waiting for the model to load (first run downloads ~5 GB)…"
	@# Poll /health, do NOT grep for "warmed up": that line is printed by the
	@# startup handler, which finishes BEFORE uvicorn begins accepting
	@# connections. Grepping it races the socket and the next command gets
	@# "connection refused".
	@P=$(or $(LATINA_PORT),8000); 	 for i in $$(seq 1 240); do 	   curl -s --max-time 3 http://localhost:$$P/health 2>/dev/null | grep -q '"ok":true' && 	     { echo "ready on :$$P"; exit 0; }; 	   grep -q "Traceback" latina.log 2>/dev/null && { tail -20 latina.log; exit 1; }; 	   sleep 5; 	 done; echo "timed out after 20 min"; tail -20 latina.log; exit 1

test:  ## synthesize, time it, write out.wav — first audio must be << total
	@.venv/bin/python smoke_test.py $(URL)

stop:  ## kill whatever holds the port
	@PID=$$(ss -ltnp 2>/dev/null | grep ':$(or $(LATINA_PORT),8000)' | grep -oP 'pid=\K[0-9]+' | head -1); \
	 if [ -n "$$PID" ]; then kill -9 $$PID && echo "stopped $$PID"; else echo "nothing listening"; fi

docker:  ## build the image for RunPod
	docker build -t latina-voice:latest .

clean:  ## remove venv and artifacts (model weights stay in ~/.cache)
	rm -rf .venv __pycache__ latina/__pycache__ out.wav latina.log
