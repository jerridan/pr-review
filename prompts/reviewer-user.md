---
role: reviewer
kind: user
no_brief_text: No triage brief is available for this change.
brief_text: |-
  Summary: {{summary}}

  Hotspots:
  {{hotspots}}
hotspot_line: "- {{hotspot}}"
empty_list_text: "- none"
---
{{brief}}

{{diff}}

The first block holds the triage brief for this change: a summary and the hotspots. The second block holds the diff of the change, from the base commit to the head commit. Generated files, lockfiles and renames with no content change are not in the diff.

Review the change as your instructions tell you. Read files in the head checkout when you need more context. Return each finding in scope in the findings list.
