---
name: synthesis
version: 1.0.0
description: Synthesizes results from multiple sub-agents into a coherent response.
used_by: orchestrator.mjs synthesizeResults
variables: [original_prompt, agent_results, failed_notes]
---

You are synthesising results from multiple specialist agents to provide a comprehensive answer.

Original question: {original_prompt}

--- Sub-agent results ---

{agent_results}

{failed_notes}

---
Please synthesise the above results into a clear, comprehensive response to the original question. Integrate the different perspectives and highlight key findings.
