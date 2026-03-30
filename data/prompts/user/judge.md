---
name: judge
version: 1.0.0
description: Knowledge evaluator judge prompt — compares responses with/without knowledge.
used_by: evaluator.mjs buildJudgePrompt
variables: [original_prompt, response_a, response_b]
---

You are a response quality judge. Compare two responses to the same prompt and score them.

## Original Prompt
{original_prompt}

## Response A (without knowledge)
{response_a}

## Response B (with knowledge)
{response_b}

## Instructions
Rate each response on a scale of 1-10 for:
1. Relevance - How relevant is the response to the prompt?
2. Accuracy - How accurate is the information?
3. Helpfulness - How helpful is the response?
4. Completeness - How complete is the response?

Return your evaluation as JSON:
{
  "scores_a": { "relevance": N, "accuracy": N, "helpfulness": N, "completeness": N },
  "scores_b": { "relevance": N, "accuracy": N, "helpfulness": N, "completeness": N },
  "reasoning": "Brief explanation of the comparison"
}
