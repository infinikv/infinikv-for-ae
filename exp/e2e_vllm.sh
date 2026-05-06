#!/usr/bin/env bash
set -euo pipefail

# =========================
# Basic configuration
# =========================
VLLM_BIN="${VLLM_BIN:-vllm}"
VLLM_PORT="${VLLM_PORT:-8200}"

# RREQUEST_RATES=(0.25 0.5 0.75 1 1.25 1.5 1.75 2.0)
REQUEST_RATES=(0.2 0.3 0.4 0.5 0.6)
# REQUEST_RATES=(0.5)
NUM_PROMPTS="${NUM_PROMPTS:-1000}"

GPU_MEMORY_UTILIZATION="${GPU_MEMORY_UTILIZATION:-0.7}"
MAX_MODEL_LEN="${MAX_MODEL_LEN:-128K}"
MAX_NUM_BATCHED_TOKENS="${MAX_NUM_BATCHED_TOKENS:-131072}"

MODEL_NAME="${MODEL_NAME:-/data/models/Llama-3.1-8B-Instruct}"
TOKENIZER_PATH="${TOKENIZER_PATH:-$MODEL_NAME}"
DATASET_NAME="${DATASET_NAME:-LEval}"
DATASET_PATH="${DATASET_PATH:-LEval-data}"

STARTUP_TIMEOUT="${STARTUP_TIMEOUT:-600}"         # seconds
HEALTH_CHECK_INTERVAL="${HEALTH_CHECK_INTERVAL:-5}" # seconds
SHUTDOWN_WAIT="${SHUTDOWN_WAIT:-10}"              # seconds

HOST="localhost"
HEALTH_ENDPOINT="http://${HOST}:${VLLM_PORT}/health"

TIMESTAMP="$(date +%F_%H-%M-%S)"
RESULT_DIR="${RESULT_DIR:-./results/${TIMESTAMP}}"
LOG_DIR="${LOG_DIR:-./logs/${TIMESTAMP}}"

mkdir -p "${RESULT_DIR}" "${LOG_DIR}"

# =========================
# Utility functions
# =========================
cleanup_server() {
    local pid="${1:-}"
    if [[ -z "${pid}" ]]; then
        return 0
    fi

    if ps -p "${pid}" > /dev/null 2>&1; then
        echo "[INFO] Sending TERM to server PID ${pid}"
        kill -TERM "${pid}" || true
        sleep "${SHUTDOWN_WAIT}"
    fi

    if ps -p "${pid}" > /dev/null 2>&1; then
        echo "[WARN] Server PID ${pid} still alive, force killing"
        kill -9 "${pid}" || true
    fi
}

wait_for_server() {
    local elapsed=0

    until curl -fsS "${HEALTH_ENDPOINT}" > /dev/null 2>&1; do
        sleep "${HEALTH_CHECK_INTERVAL}"
        elapsed=$((elapsed + HEALTH_CHECK_INTERVAL))

        if [[ "${elapsed}" -ge "${STARTUP_TIMEOUT}" ]]; then
            echo "[ERROR] Server did not become healthy within ${STARTUP_TIMEOUT}s"
            return 1
        fi
    done

    return 0
}

# Ensure cleanup on exit
SERVER_PID=""
trap 'cleanup_server "${SERVER_PID}"' EXIT

# =========================
# Main loop
# =========================
for RATE in "${REQUEST_RATES[@]}"; do
    echo "=================================================="
    echo "[INFO] Running benchmark for request rate: ${RATE}"
    echo "=================================================="

    SERVER_LOG="${LOG_DIR}/server_rate_${RATE}.log"
    BENCH_LOG="${LOG_DIR}/bench_rate_${RATE}.log"
    RATE_RESULT_DIR="${RESULT_DIR}/rate_${RATE}"

    mkdir -p "${RATE_RESULT_DIR}"

    # Clean possible old process on same port if needed
    # Uncomment this only if your environment often leaves stale servers:
    # fuser -k "${VLLM_PORT}/tcp" || true
    # sleep 2

    echo "[INFO] Starting vLLM server..."
    "${VLLM_BIN}" serve "${MODEL_NAME}" \
        --host "${HOST}" \
        --port "${VLLM_PORT}" \
        --tokenizer "${TOKENIZER_PATH}" \
        --gpu-memory-utilization "${GPU_MEMORY_UTILIZATION}" \
        --max-model-len "${MAX_MODEL_LEN}" \
        --max-num-batched-tokens "${MAX_NUM_BATCHED_TOKENS}" \
        > "${SERVER_LOG}" 2>&1 &

    SERVER_PID=$!
    echo "[INFO] Server PID: ${SERVER_PID}"
    echo "[INFO] Waiting for health endpoint: ${HEALTH_ENDPOINT}"

    if ! wait_for_server; then
        echo "[ERROR] Server startup failed for rate ${RATE}"
        cleanup_server "${SERVER_PID}"
        SERVER_PID=""
        exit 1
    fi

    echo "[INFO] Server is healthy. Starting benchmark..."

    unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY no_proxy NO_PROXY

    set +e
    "${VLLM_BIN}" bench serve \
        --seed "$(date +%s)" \
        --host "${HOST}" \
        --backend vllm \
        --port "${VLLM_PORT}" \
        --save-result \
        --tokenizer "${TOKENIZER_PATH}" \
        --model "${MODEL_NAME}" \
        --dataset-name "${DATASET_NAME}" \
        --dataset-path "${DATASET_PATH}" \
        --num-prompts "${NUM_PROMPTS}" \
        --request-rate "${RATE}" \
        --percentile-metrics ttft,tpot,itl,e2el \
        --metric-percentiles 80,85,95,99 \
        --result-dir "${RATE_RESULT_DIR}" \
        > "${BENCH_LOG}" 2>&1
    BENCH_EXIT_CODE=$?
    set -e

    echo "[INFO] Benchmark finished for rate ${RATE} with exit code ${BENCH_EXIT_CODE}"

    echo "[INFO] Restarting server for next rate..."
    cleanup_server "${SERVER_PID}"
    SERVER_PID=""

    if [[ "${BENCH_EXIT_CODE}" -ne 0 ]]; then
        echo "[ERROR] Benchmark failed for rate ${RATE}. Check:"
        echo "  - ${SERVER_LOG}"
        echo "  - ${BENCH_LOG}"
        exit "${BENCH_EXIT_CODE}"
    fi

    sleep 5
done

echo "[INFO] All request rates finished successfully."
echo "[INFO] Results directory: ${RESULT_DIR}"
echo "[INFO] Logs directory: ${LOG_DIR}"
