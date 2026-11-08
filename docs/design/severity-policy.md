# Severity policy

Status: draft, 2026-11-07, amended 2026-11-08 after the first labeling round. Part of D5 in TICKETS.md.

This policy gives one rule set for the severity of a review finding. Three readers apply it: the labeler who writes `golden.json` for an eval case, the verifier when it sets the severity of a finding, and the judge of the labeling loop. One policy in three places makes the severity agreement of the eval measure one thing.

The policy decides a label from the consequence of the defect and from the path a person needs to reach it. It never decides a label from the size of the fix, from how often a path is used, or from how the author feels about the finding.

## Labels

Three labels post. Three outcomes do not post.

**Blocking.** Merging as-is harms a user, an operator or the project on a normal path. Any of these is blocking:

- a defect on a normal path,
- a security hole,
- a break of a contract that another service, client or caller relies on,
- stored data lost or corrupted that the person cannot see at the time and cannot put right,
- a status code in the wrong class,
- a missing test whose ceiling is blocking, on a surface with no test,
- a test that gives false confidence,
- a control that a keyboard or screen-reader user cannot operate, or a task they cannot complete.

**Suggestion.** The finding is real and worth a comment. The author decides. Any of these is a suggestion:

- a defect on an unusual path,
- a loss the person sees at the time and can put right,
- a wrong message, hint or label, with the outcome still correct,
- a wrong status code within the right class,
- a missing test one step below its ceiling,
- a latent defect with no live caller,
- a consequence held off only by a weak guard that the change introduced,
- an accessibility gap that leaves the task possible, but with less information than a sighted or mouse user gets.

**Nit.** Correct but minor: a name, a message that is true but unclear, a small duplication, a test stub that duplicates a shared one. Post a nit only when the fix is cheap.

**Don't post.** True but not worth the author's time: a repo convention broken with no wrong result for a reader or a user, a process that the review cannot judge from the code, a stale base, style the repo does not enforce, a note that restates the description of the change.

**Not real.** The code contradicts the claim, or an enforced guard upstream prevents the consequence. This is a fact decided with the code open, never by vote.

**Unsure.** The repository does not settle the question. The answer needs production data, a runtime or an external service. A process question is not unsure. It is don't post.

The verifier posts blocking, suggestion and nit. It records don't post, not real and unsure in the record and posts none of them. A golden finding carries one of the six labels. Only the goldens with the three posted labels count for recall. A posted finding that matches a golden with don't post, not real or unsure is a false positive.

## Normal path

A path is normal when a person can reach it with supported controls or documented calls, however rarely they do. A path is unusual only when it needs one of these first: a failure, a race or specific timing, a second actor, or a client that is behind the deploy. How often a path is used never changes the label. The consequence decides the label, together with whether the person sees it at the time and can put it right.

Rare inputs are not unusual paths. An edge value, a numeric corner case, a near-tolerance input or an uncommon configuration that a supported call accepts is a normal path. A documented example, an installation step or a CI setup that the repository describes is a normal path. The list above is the whole test for an unusual path.

A defect on a normal path whose only consequence is a loss the person sees at the time and can put right is a suggestion. The Stored data section says when a person sees a loss.

A defect that needs the person to act before a visible loading state finishes is a suggestion, or a nit when the window is short. If no loading state is shown, or a failed load leaves the page in the same state, the path is normal.

## Stored data

Stored data is data that a person or another system depends on later and cannot regenerate: saved configuration, user records, message history, results and events already written. Scratch state with a time to live, state that the next request rebuilds, a cache with a source of truth elsewhere, and unsaved editor work are not stored data.

Stored data lost or corrupted is blocking, unless the person sees it at the time of the action and can put it right. Then it is a suggestion. The person sees it only when a message says what happened, or when the result on the screen is plainly wrong. A vague or briefly shown indicator does not count.

Stale or wrong stored data that reaches a user, or a system outside the project, is judged by this section. A check that fails to stop it is part of the consequence, not a mitigation. Content that a safety or moderation check withheld, and that still reaches a user or an external system, is blocking. The same content seen only by operators through internal tools is not, by itself, a finding.

## Switches, and clients that are behind

A client, app build or integration that is behind the deploy does not make a path normal. If the coupling is additive, or sits behind a switch that this change adds and leaves off, the finding is a suggestion. A switch that existed before the change counts as live.

This holds also when the change exists to add the feature behind the switch. No user reaches the path until a later change turns the switch on, and that change is the one that makes the defect blocking. The source of a golden finding may rate such a defect higher; the label follows this policy, not the source.

A switch or an input that can take a state the code does not handle is a latent defect: a suggestion, whatever an operator is likely to do.

## Accessibility

An accessibility finding takes its label from the task, not from the element.

- A control that a keyboard or screen-reader user cannot operate, or a task they cannot complete, is blocking.
- A control they can operate, but with less information than a sighted or mouse user gets, is blocking when the missing information decides the outcome of a normal path. Examples: an error state that only color shows, a required field with no accessible name, a status change that no live region announces.
- The same gap on an element that does not decide an outcome, such as a decorative image with no alternative text or a redundant label, is a suggestion.
- Wording of an accessible name or a description is a nit.

## Tests

Label a missing test in two steps. First, label the defect the test would catch: what would the untested case be under this policy if it broke? That label is the ceiling. Second, look at the surface the change touches, as its tests are organised: an endpoint, a component, a function, a job. If the surface has no test at all, or only edge-case tests, the missing test takes the ceiling label. If the surface is tested and the case the change adds or changes is not, the missing test is one step below the ceiling.

A surface counts as tested when a test drives the code the change added through the surface's own entry point: rendering the component and acting on it, calling the route, running the job. Tests of helpers, neighbouring components or pure functions do not make it tested.

Shared functionality is the exception. When the change wires an already-tested shared capability into a new place with no logic of its own, the shared capability's tests count, and a missing test there is don't post. When the change adds the same logic at several places, one test at one representative place covers the pattern, and missing tests at the other places are don't post. A place whose logic differs from the pattern is its own surface. Logic repeated across places that could live in the shared capability is a duplication finding, not a test finding.

One finding per missing-test subject. When several missing-test findings concern the same surface or the same capability, on whatever lines, they are one finding that lists the cases. The label is the highest of the merged cases.

A test that gives false confidence is blocking, whatever else is tested. A test gives false confidence when its assertion still passes with the code it names removed, or with the assertion flipped. Fix it or delete it.

Internal tooling is code whose output never reaches a user's system or data: build scripts, local development helpers, test harnesses, documentation generators and agent or skill definitions. A tool that reads or writes a user's data or infrastructure is production code, whoever runs it. CI that deploys, migrates, gates merges or decides what ships is production code. A missing-test finding on internal tooling is one step lower than on production code: blocking becomes suggestion, suggestion becomes nit. A false-confidence test stays blocking everywhere.

A test stub that duplicates a shared one, or sits inline where a shared one should be, is a nit, or don't post when the duplication is harmless. It is blocking when the stub contradicts the real contract in a way the test relies on, such as an assertion on a field the real API renamed or removed. A stub that leaves out fields the test does not use is fine.

## Claims that are partly true

A consequence that an enforced guard upstream prevents is not real: a schema that requires the field, validation that rejects the input, a type that cannot hold the value, or a path no caller can reach.

A consequence held off only by a weak guard, such as a model prompt, a convention or documentation, is real. If the change introduced the path or the weak guard, it is a suggestion. If both were there before the change, it is pre-existing and out of scope.

A description or a spec that asks for the behaviour does not lower a finding. A sibling with the same gap does not lower a finding and is not a separate finding. When the change introduces a gap and unchanged sibling code has the same gap, the finding names the sibling too, so both get fixed together. This is the one case where a review finding names pre-existing code.

## Messages and status codes

A status code in the wrong class, such as a 5xx for a client error or a 2xx for a failure, is blocking. Callers, retries and monitoring act on the class. A wrong code within the right class, or a wrong message, hint or label with the outcome still correct, is a suggestion. A message that is true but unclear is a nit. The size of the fix never changes the label.

Placeholder text or a wrong value that ships to a user-facing page or message is a defect on a normal path: blocking.

## Process and conventions

A finding whose harm depends on a process outside the repository, such as a sign-off, a rollout step, a calibration, a stale base or an operator's choice, is don't post. The review judges the code and trusts the author to follow the process.

A repo convention broken with no wrong result for a reader or a user, such as a ticket reference in a comment or a numbering gap in design records, is don't post. The convention binds the author. The review does not repeat it.

## How the pipeline uses the labels

- Blocking findings post on every run and set the verdict to "would request changes". Suggestions and nits post on the first run only, as section 3.5 of the high-level design says.
- The non-blocking cap of section 3.6 applies to suggestions and nits, never to blocking findings.
- Merge may downgrade a severity when it sees the full set. It never upgrades.
- The eval counts severity agreement on matched findings as exact equality of the posted label. The first-pass acceptance rate of the labeling loop is the bar that agreement is read against, not 100 percent.
