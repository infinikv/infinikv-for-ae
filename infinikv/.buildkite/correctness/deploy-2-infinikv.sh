#!/bin/bash

# ASSUMPTION: infinikv/vllm-openai:latest-nightly Docker image is available

# Overview:
# This script is used to deploy 2 vLLM + InfiniKV serving engines on port 8000 and 8001
# They will have a peer to peer connection through a Redis server on port 6379
# The purpose is to send requests to the first serving engine to store KV Caches and then send requests to the second serving engine to retrieve KV Caches
# This way the responses returned by the second serving engine can be used to test the correctness of InfiniKV KV Transfer

# Arguments:
MODEL_URL=$1

if [ -z "$MODEL_URL" ]; then
    echo "Usage: $0 <MODEL_URL>"
    echo "Example: $0 deepseek-ai/DeepSeek-V2-Lite"
    exit 1
fi

echo "🚀 Starting dual InfiniKV setup with:"
echo "   Model: $MODEL_URL"
echo "   Producer port: 8000"
echo "   Consumer port: 8001"

# Utility:
free_port() {
    if [ -z "$1" ]; then
        echo "Usage: free_port <port>"
        return 1
    fi

    local port=$1
    
    echo "🧹 Cleaning up any existing containers on port $port..."
    
    # Kill any processes using the port directly
    sudo lsof -ti:$port | xargs -r sudo kill -9 2>/dev/null || true
    
    # Kill and remove containers using this port
    sudo docker ps -q --filter "publish=$port" | xargs -r sudo docker kill 2>/dev/null || true
    sudo docker ps -aq --filter "publish=$port" | xargs -r sudo docker rm -f 2>/dev/null || true
    
    # Wait a moment for port to be released
    sleep 3
    
    # Verify port is free
    if sudo lsof -i:$port >/dev/null 2>&1; then
        echo "⚠️ Port $port still in use after cleanup, waiting longer..."
        sleep 5
        sudo lsof -ti:$port | xargs -r sudo kill -9 2>/dev/null || true
        sleep 2
    fi
    
    # Final check
    if sudo lsof -i:$port >/dev/null 2>&1; then
        echo "❌ Failed to free port $port"
        echo "🔍 Processes still using port $port:"
        sudo lsof -i:$port || true
        return 1
    else
        echo "✅ Port $port is now free"
    fi
}

# Make sure all the scripts run and cooperate with each other in the .buildkite/correctness directory
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd $SCRIPT_DIR

# Clean up ports
free_port 8000
if [ $? -ne 0 ]; then
    echo "❌ Failed to free port 8000, cannot continue"
    exit 1
fi

free_port 8001
if [ $? -ne 0 ]; then
    echo "❌ Failed to free port 8001, cannot continue"
    exit 1
fi

# Clean up containers by name (in case they exist but aren't bound to ports)
echo "🧹 Cleaning up any existing InfiniKV containers..."
sudo docker rm -f infinikv-producer 2>/dev/null || true
sudo docker rm -f infinikv-consumer 2>/dev/null || true
sudo docker rm -f vllm-server 2>/dev/null || true

# Install and start Redis server
echo "🔧 Installing Redis server..."
sudo apt-get update -qq
sudo apt-get install -y redis-server

echo "🔧 Starting Redis server on port 6379..."
sudo systemctl stop redis-server 2>/dev/null || true
sudo systemctl start redis-server
sudo systemctl enable redis-server

# Wait for Redis server to be ready
echo "⏳ Waiting for Redis server to be ready..."
sleep 5

# Test Redis connection
if ! redis-cli ping > /dev/null 2>&1; then
    echo "❌ Redis server failed to start"
    exit 1
fi
echo "✅ Redis server is running and responding to ping"

# Deploy the first vLLM + InfiniKV serving engine on port 8000 (KV producer)
echo "🔧 Starting KV producer on port 8000..."
PRODUCER_ID=$(sudo docker run -d --gpus all \
    --name infinikv-producer \
    --env "HF_TOKEN=$HF_TOKEN" \
    --env "INFINIKV_USE_EXPERIMENTAL=True" \
    --env "INFINIKV_CHUNK_SIZE=256" \
    --env "INFINIKV_LOCAL_CPU=True" \
    --env "INFINIKV_MAX_LOCAL_CPU_SIZE=1.0" \
    --env "INFINIKV_REMOTE_URL=redis://host.docker.internal:6379" \
    --env "INFINIKV_REMOTE_SERDE=naive" \
    --env "CUDA_VISIBLE_DEVICES=0" \
    --env "PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True" \
    --env "VLLM_MLA_DISABLE=0" \
    --env "CUDA_LAUNCH_BLOCKING=1" \
    --add-host=host.docker.internal:host-gateway \
    -v ~/.cache/huggingface:/root/.cache/huggingface \
    -p 8000:8000 \
    infinikv/vllm-openai:latest-nightly \
    $MODEL_URL \
    --port 8000 \
    --trust-remote-code \
    --max-model-len 8192 \
    --kv-transfer-config '{"kv_connector":"InfiniKVConnectorV1","kv_role":"kv_both"}')

echo "Started KV producer container: $PRODUCER_ID"

# Deploy the second vLLM + InfiniKV serving engine on port 8001 (KV consumer)
echo "🔧 Starting KV consumer on port 8001..."
CONSUMER_ID=$(sudo docker run -d --gpus all \
    --name infinikv-consumer \
    --env "HF_TOKEN=$HF_TOKEN" \
    --env "INFINIKV_USE_EXPERIMENTAL=True" \
    --env "INFINIKV_CHUNK_SIZE=256" \
    --env "INFINIKV_LOCAL_CPU=True" \
    --env "INFINIKV_MAX_LOCAL_CPU_SIZE=1.0" \
    --env "INFINIKV_REMOTE_URL=redis://host.docker.internal:6379" \
    --env "INFINIKV_REMOTE_SERDE=naive" \
    --env "CUDA_VISIBLE_DEVICES=1" \
    --env "PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True" \
    --env "VLLM_MLA_DISABLE=0" \
    --env "CUDA_LAUNCH_BLOCKING=1" \
    --add-host=host.docker.internal:host-gateway \
    -v ~/.cache/huggingface:/root/.cache/huggingface \
    -p 8001:8001 \
    infinikv/vllm-openai:latest-nightly \
    $MODEL_URL \
    --port 8001 \
    --trust-remote-code \
    --max-model-len 8192 \
    --kv-transfer-config '{"kv_connector":"InfiniKVConnectorV1","kv_role":"kv_both"}')

# Working deployment:
# MODEL_URL="meta-llama/Llama-3.1-8B"
# sudo docker run -d --gpus all \
#     --env "HF_TOKEN=$HF_TOKEN" \
#     --env "INFINIKV_USE_EXPERIMENTAL=True" \
#     --env "INFINIKV_CHUNK_SIZE=256" \
#     --env "INFINIKV_LOCAL_CPU=True" \
#     --env "TORCH_USE_CUDA_DSA=1" \
#     --env "INFINIKV_MAX_LOCAL_CPU_SIZE=1.0" \
#     --env "INFINIKV_REMOTE_URL=redis://host.docker.internal:6379" \
#     --env "INFINIKV_REMOTE_SERDE=naive" \
#     --env "CUDA_VISIBLE_DEVICES=1" \
#     --env "PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True" \
#     --env "VLLM_MLA_DISABLE=0" \
#     --env "CUDA_LAUNCH_BLOCKING=1" \
#     --add-host=host.docker.internal:host-gateway \
#     -v ~/.cache/huggingface:/root/.cache/huggingface \
#     -p 8001:8001 \
#     infinikv/vllm-openai:latest-nightly \
#     $MODEL_URL \
#     --port 8001 \
#     --trust-remote-code \
#     --max-model-len 8192 \
#     --kv-transfer-config '{"kv_connector":"InfiniKVConnectorV1","kv_role":"kv_both"}'

echo "Started KV consumer container: $CONSUMER_ID"

# Check if containers started successfully
sleep 10
if ! sudo docker ps -q --filter "id=$PRODUCER_ID" | grep -q .; then
    echo "❌ Producer container failed to start. Checking logs..."
    sudo docker logs $PRODUCER_ID
    exit 1
fi

if ! sudo docker ps -q --filter "id=$CONSUMER_ID" | grep -q .; then
    echo "❌ Consumer container failed to start. Checking logs..."
    sudo docker logs $CONSUMER_ID
    exit 1
fi

# Wait longer for model loading
echo "⏳ Waiting for models to load (this may take several minutes)..."
echo "📊 Monitoring container status and logs..."

# Wait with periodic status updates and early health checks
elapsed_seconds=0
early_health_success=false
while true; do
    elapsed_seconds=$((elapsed_seconds + 10))
    echo ""
    echo "🕐 Model loading progress: ${elapsed_seconds} seconds elapsed"
    
    # Check if containers are still running
    if ! sudo docker ps -q --filter "id=$PRODUCER_ID" | grep -q .; then
        echo "❌ Producer container stopped unexpectedly!"
        echo "📋 Producer logs:"
        sudo docker logs --tail 20 $PRODUCER_ID
        exit 1
    fi
    
    if ! sudo docker ps -q --filter "id=$CONSUMER_ID" | grep -q .; then
        echo "❌ Consumer container stopped unexpectedly!"
        echo "📋 Consumer logs:"
        sudo docker logs --tail 20 $CONSUMER_ID
        exit 1
    fi
    
    # Check health endpoints every 20 seconds after 60 seconds have elapsed
    if (( elapsed_seconds >= 60 && elapsed_seconds % 20 == 0 )); then
        echo "🔍 Early health check: testing both health endpoints"
        producer_healthy=false
        consumer_healthy=false
        
        if curl --fail -s --max-time 5 http://localhost:8000/health > /dev/null 2>&1; then
            echo "  ✅ Producer (port 8000) is healthy"
            producer_healthy=true
        else
            echo "  ⏳ Producer (port 8000) not ready yet"
        fi
        
        if curl --fail -s --max-time 5 http://localhost:8001/health > /dev/null 2>&1; then
            echo "  ✅ Consumer (port 8001) is healthy"
            consumer_healthy=true
        else
            echo "  ⏳ Consumer (port 8001) not ready yet"
        fi
        
        if $producer_healthy && $consumer_healthy; then
            echo "✅ Both servers responded to health checks early! Breaking out of wait loop."
            early_health_success=true
            break
        fi
    fi
    
    # Show recent logs every 30 seconds (every 3rd iteration)
    if (( elapsed_seconds % 30 == 0 )); then
        echo "📋 Recent producer logs (port 8000):"
        sudo docker logs --tail 5 $PRODUCER_ID | sed 's/^/  /'
        echo "📋 Recent consumer logs (port 8001):"
        sudo docker logs --tail 5 $CONSUMER_ID | sed 's/^/  /'
    fi
    
    # Break after 300 seconds (5 minutes) to avoid infinite loop
    if (( elapsed_seconds >= 300 )); then
        echo "⚠️ Model loading taking longer than expected (${elapsed_seconds}s), continuing to health checks..."
        break
    fi
    
    sleep 10
done

echo "✅ Model loading wait period completed"

# Wait for both serving engines to be ready
if [ "$early_health_success" = true ]; then
    echo "✅ Both servers are already healthy (confirmed during early checks)!"
else
    echo "🔍 Checking server health..."
    echo "📡 Testing health endpoints: http://localhost:8000/health and http://localhost:8001/health"
    total_time_elapsed=0
    health_check_count=0
    until curl --fail -s http://localhost:8000/health && curl --fail -s http://localhost:8001/health; do
        health_check_count=$((health_check_count + 1))
        echo "⏳ Health check attempt ${health_check_count}: servers not ready yet..."
        
        # Test each endpoint individually to see which one is failing
        if curl --fail -s http://localhost:8000/health > /dev/null; then
            echo "  ✅ Producer (port 8000) is healthy"
        else
            echo "  ⏳ Producer (port 8000) not ready"
        fi
        
        if curl --fail -s http://localhost:8001/health > /dev/null; then
            echo "  ✅ Consumer (port 8001) is healthy"
        else
            echo "  ⏳ Consumer (port 8001) not ready"
        fi
        
        if ! sudo docker ps -q --filter "id=$PRODUCER_ID" | grep -q .; then
            echo "❌ Producer container exited prematurely"
            sudo docker logs $PRODUCER_ID
            exit 1
        fi
        if ! sudo docker ps -q --filter "id=$CONSUMER_ID" | grep -q .; then
            echo "❌ Consumer container exited prematurely"
            sudo docker logs $CONSUMER_ID
            exit 1
        fi
        sleep 10
        total_time_elapsed=$((total_time_elapsed + 10))
        
        # Show recent logs every 60 seconds during health checks
        if (( health_check_count % 6 == 0 )); then
            echo "📋 Recent container logs (health check debugging):"
            echo "  Producer (last 3 lines):"
            sudo docker logs --tail 3 $PRODUCER_ID | sed 's/^/    /'
            echo "  Consumer (last 3 lines):"
            sudo docker logs --tail 3 $CONSUMER_ID | sed 's/^/    /'
        fi
    done

    echo "✅ Both servers are healthy!"
fi

echo "🔍 Checking if models are loaded..."
echo "📡 Testing model endpoints for: $MODEL_URL"
model_check_count=0
until curl --fail -s http://localhost:8000/v1/models | grep -q "$MODEL_URL" && curl --fail -s http://localhost:8001/v1/models | grep -q "$MODEL_URL"; do
    model_check_count=$((model_check_count + 1))
    echo "⏳ Model check attempt ${model_check_count}: $MODEL_URL not fully loaded yet..."
    
    # Check each model endpoint individually
    if curl --fail -s http://localhost:8000/v1/models | grep -q "$MODEL_URL"; then
        echo "  ✅ Producer model loaded"
    else
        echo "  ⏳ Producer model loading..."
    fi
    
    if curl --fail -s http://localhost:8001/v1/models | grep -q "$MODEL_URL"; then
        echo "  ✅ Consumer model loaded"
    else
        echo "  ⏳ Consumer model loading..."
    fi
    
    if ! sudo docker ps -q --filter "id=$PRODUCER_ID" | grep -q .; then
        echo "❌ Producer container exited prematurely"
        exit 1
    fi
    if ! sudo docker ps -q --filter "id=$CONSUMER_ID" | grep -q .; then
        echo "❌ Consumer container exited prematurely"
        exit 1
    fi
    
    sleep 10
    total_time_elapsed=$((total_time_elapsed + 10))
    
    # Show detailed logs periodically during model loading
    if (( model_check_count % 3 == 0 )); then
        echo "📋 Model loading progress logs:"
        echo "  Producer (last 5 lines):"
        sudo docker logs --tail 5 $PRODUCER_ID | sed 's/^/    /'
        echo "  Consumer (last 5 lines):"
        sudo docker logs --tail 5 $CONSUMER_ID | sed 's/^/    /'
        echo "--------------------------------"
    fi
done

echo "✅ Both InfiniKV serving engines are ready and models are loaded"
echo "🔧 Producer (KV storage): http://localhost:8000"
echo "🔧 Consumer (KV retrieval): http://localhost:8001"
echo "🔧 Redis server: localhost:6379"

# Store container IDs for cleanup scripts
echo "$PRODUCER_ID" > .infinikv-producer.pid  
echo "$CONSUMER_ID" > .infinikv-consumer.pid

echo "✅ Dual InfiniKV setup completed successfully!"
echo "ℹ️  Use 'sudo docker kill $PRODUCER_ID $CONSUMER_ID' to stop containers"
echo "ℹ️  Use 'sudo systemctl stop redis-server' to stop Redis" 