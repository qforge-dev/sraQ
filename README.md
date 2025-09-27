# Real-Time Intent Detection for Multithreaded Conversations

## Mission Statement

Keep multi-threaded assistants snappy by routing most intents to a tiny, calibrated model—escalating to a big model only when confidence is low. Result: big-model quality, small-model speed.

Across domains like recruitment, sales, AI assistants handle multi-threaded information streams (simultaneous chat threads, multiple data sources, or parallel tasks) so users need not context-switch.

But many recent examples of granola/poke/cluely-like interfaces shows that problem lays in latency & accuracy that enterprise products will not adopt when there are big latency bottlenecks, or you have to choose between speed and quality.

We wanted to tackle that issue by finetuning a small super fast model to unlock these use-cases at scale.

## TLDR;

### Benchmarks show great response quality compared to other models working in a fraction of time thanks to small model size.

<img width="813" height="472" alt="Screenshot_2025-09-26_at_5 04 38_PM" src="https://github.com/user-attachments/assets/3757753e-9808-4020-89aa-35bc1a1edf22" />

## Technical Problem

- **Latency bottleneck**: Large models in voice, WhatsApp, or Discord agents hog the main conversation thread, introducing lag.
- **Quality vs. speed**: We need intent detection that preserves the accuracy of a bigger model while delivering responses fast enough to keep multi-threaded conversations fluid.
- **Goal**: Maintain high-quality intent classification with minimal response times so the main thread remains free most of the time.

## Solution Overview

- **Hybrid stack**: Pair a large teacher model with a distilled student (`gpt-oss-20b`) optimized for low-latency inference.
- **High-quality synthetic data**: Generate nuanced, high-reasoning multi-turn conversations to reflect the target use cases.
- **Tight validation loop**: Manually inspect samples to ensure alignment with production expectations and mitigate hallucinations.
- **Explicit intent contract**: Leverage the shared `intent-prompt.ts` system prompt so every sample follows the same action schema (`reply`, `start_task`, `update_task`, `cancel_task`, `noop`) and references the live task ledger the way production traffic does.

## Dataset

- **Size**: 1,000 synthetic multi-turn conversations crafted with GPT-5 (high reasoning mode) tailored to intent-routing scenarios.
- **Design principles**:
  - Coverage of overlapping intents, clarifications, and pivot points common in real-time support flows.
  - Variation in tone, modality (voice/chat), and handoff cues to stress-test the model.
- **Availability**: Included in the repository for reproducibility and further experimentation.
- **Intent prompt alignment**: Each row is produced by the Intent Orchestrator prompt in `intent-prompt.ts`, which enforces the contract between the message transcript, the task ledger, and a single chosen action. The same prompt is used in inference, so training examples mirror the assistant’s runtime decision surface.
- **Schema**: Every record contains `messages`, `tasks`, and a `final` action string validated against the Zod schema exported from `intent-prompt.ts`, ensuring downstream consumers can parse and execute decisions without defensive checks.
- **Action coverage**: The generator balances samples across all five actions and validates that `start_task`, `update_task`, and `cancel_task` reference real task ids, replicating edge cases the orchestrator faces in production.

## Training & Distillation

- **Teacher model**: GPT-5 (high reasoning) generates authoritative intent labels and responses for every conversation turn.
- **Student model**: Fine-tune and distill into `gpt-oss-20b`, targeting a balance between speed and intent fidelity.
- **LoRA ready**: The dataset is structured for LoRA adapters on any base model; we picked `gpt-oss-20b` because it balances fast inference with strong reasoning.
- **Pipeline**:
  1. Generate intent annotations and exemplar responses via GPT-5 (high reasoning).
  2. Validate a stratified sample of 100 conversations; observed 99% correctness after manual review.
  3. Distill the teacher’s signals into `gpt-oss-20b` with latency-focused optimization.

## Evaluation

- **Manual audit**: 100-row sample validation, confirming 99% intent-label accuracy.
- **Benchmark suite**: Measures per-intent precision/recall, latency, and throughput.
- **Comparison**: Track performance deltas against the GPT-5 teacher to confirm bounded quality loss.

## Raw Benchmark Results

<img width="1445" height="668" alt="Screenshot_2025-09-26_at_4 46 12_PM" src="https://github.com/user-attachments/assets/18e870a9-b2ba-4820-b760-243ba6341f5e" />
<img width="1458" height="679" alt="Screenshot_2025-09-26_at_4 46 27_PM" src="https://github.com/user-attachments/assets/e60f9683-7adf-484e-bbe9-65e51ca5f11e" />
<img width="1464" height="666" alt="Screenshot_2025-09-26_at_4 46 37_PM" src="https://github.com/user-attachments/assets/6872f4ec-9133-4463-b603-88ea53d01d4c" />
<img width="1478" height="670" alt="Screenshot_2025-09-26_at_4 47 48_PM" src="https://github.com/user-attachments/assets/20a2ecef-16bc-4f40-8535-ba9a7edd2d7f" />

## Next Steps

- Integrate live latency profiling across target platforms (voice, WhatsApp, Discord).
- Expand manual validation coverage and introduce automated regression tests.
- Explore quantization or model slicing to further reduce inference cost without losing accuracy.
