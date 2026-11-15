---
role: codex-reviewer
kind: user
---
{{system}}

The text above is your system prompt. The text below is the message of the change that you review.

{{message}}

You run in a read-only sandbox in the checkout of the head commit. Read files with shell commands such as cat, rg and ls. Do not run a command that changes a file. Return one JSON object that the output schema asks for. Give each finding a suggested_fix. When you know no fix, give an empty string.
