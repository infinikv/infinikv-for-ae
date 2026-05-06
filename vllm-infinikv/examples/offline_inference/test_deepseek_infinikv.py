"""
DeepSeek-V2-Lite + InfiniKV (TARDIS) offline inference test.

Usage:
    export INFINIKV_CONFIG_FILE=configs/scenario_a/infinikv_config.yaml
    sudo -E .venv/bin/python qwen3_next/vllm/examples/offline_inference/test_deepseek_infinikv.py
"""
from vllm import LLM, SamplingParams


def main():
    prompts = [
        "The future of artificial intelligence is",
        "In a distant galaxy, there existed a civilization that",
        "The most important scientific discovery of the 21st century",
        "Once upon a time in a land far away",
    ]

    sampling_params = SamplingParams(temperature=0.8, top_p=0.95, max_tokens=128)

    llm = LLM(
        model="/data/models/DeepSeek-V2-Lite",
        tensor_parallel_size=1,
        block_size=128,
        kv_transfer_config={
            "kv_connector": "InfiniKVConnectorV1",
            "kv_role": "kv_both",
        },
        gpu_memory_utilization=0.8,
        trust_remote_code=True,
    )

    # First pass: populate the cache
    print("=" * 60)
    print("Pass 1: Populating InfiniKV cache")
    print("=" * 60)
    outputs = llm.generate(prompts, sampling_params)
    for output in outputs:
        prompt = output.prompt
        generated = output.outputs[0].text
        print(f"Prompt: {prompt!r}")
        print(f"Generated: {generated!r}")
        print()

    # Second pass: should hit the cache
    print("=" * 60)
    print("Pass 2: Should hit InfiniKV cache (check TARDIS logs)")
    print("=" * 60)
    outputs = llm.generate(prompts, sampling_params)
    for output in outputs:
        prompt = output.prompt
        generated = output.outputs[0].text
        print(f"Prompt: {prompt!r}")
        print(f"Generated: {generated!r}")
        print()

    print("DeepSeek-V2-Lite + InfiniKV test completed successfully!")


if __name__ == "__main__":
    main()
