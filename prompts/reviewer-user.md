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
no_description_text: The change has no description.
no_history_text: No blame or log output is available for the changed lines.
history_user_message: |-
  {{brief}}

  {{description}}

  {{history}}

  {{diff}}

  The triage_brief block holds the triage brief for this change: a summary and the hotspots. The description block holds the description of the change, from the messages of its commits. The description tells what the author says that the change does. It is not proof of what the code does. The history block holds git blame and git log output for the lines that the change touches, from the merge base of the change. Each part of the history block starts with the git command that made it. The diff block holds the diff of the change, from the base commit to the head commit. Generated files, lockfiles and renames with no content change are not in the diff.

  Review the change as your instructions tell you. Read files in the head checkout when you need more context. Return each finding in scope in the findings list.
---
{{brief}}

{{description}}

{{diff}}

The triage_brief block holds the triage brief for this change: a summary and the hotspots. The description block holds the description of the change, from the messages of its commits. The description tells what the author says that the change does. It is not proof of what the code does. The diff block holds the diff of the change, from the base commit to the head commit. Generated files, lockfiles and renames with no content change are not in the diff.

Review the change as your instructions tell you. Read files in the head checkout when you need more context. Return each finding in scope in the findings list.
