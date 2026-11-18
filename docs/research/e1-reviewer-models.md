# E1: the model and the effort of each reviewer

Status: done 2026-11-18. Part of D4c in TICKETS.md. The default change waits for the choice of the user.

## Result

- By the rules, diff-bugs and tests move to Sonnet 5.5 at medium effort, and description-drift moves to Haiku 5.5 at medium effort (or to Sonnet 5.5 at medium effort, which is faster; the user chooses). Security, history, conventions and docs-and-comments stay on Opus 5.5 at low effort.
- With that setting, the reviewers and the verifier find 103 posted-label goldens against 93, post 41 false findings against 36, and cost 13% less ($64.13 against $73.52 on the 28 cases), in about the same time (31 s against 33 s at the median).
- Every reviewer that stays fails on precision: the new models find as many goldens or more, but the verifier passes more of their false findings.

## Result of stage 1

- Stage 1 rejects no setting. Every new reviewer and arm pair raises at least the posted-label goldens of the current setting, less the noise of one pass.
- Before the verifier, Sonnet 5.5 medium raises more goldens than the current setting (Opus 5.5 low) in six of seven reviewers, at 0.63 times the reviewer cost. Sonnet 5.5 high raises the most goldens of the cheaper arms (96 against 70) at 0.79 times the cost. Opus 5.5 medium raises 99, at 1.61 times the cost.
- Haiku 5.5 medium matches or passes Opus 5.5 low on the three light reviewers, at about one tenth of their cost. Haiku 5.5 high costs two times Haiku medium and is slower; it raises more goldens on description-drift only.
- Every new arm gives more candidates than the current setting (1.3 to 1.9 times for all reviewers, 2.5 and 3.1 times for Haiku on the three light reviewers). The precision of each arm is not known until stage 2: the verifier decides which candidates post.
- These are raw figures, before the verifier. They are the evidence for which pairs go to stage 2, not for a default change.

## Method

Stage 1 runs the reviewers of each arm with no verifier (`pr-review eval --stage1`) and matches their raw candidates to the posted-label goldens, with the judge on the ambiguous pairs. A golden that an arm did not raise cannot be posted by it, so stage 1 can reject a setting that raises fewer goldens than the current one, less the noise of one pass. The rule: a pair is rejected when its goldens are fewer than those of the current setting less that noise; then neither the rule for a cheaper setting nor the rule for a dearer one can pass.

- The current setting is the stored arm: Opus 5.5 at low effort, from the S1 records, with pass 1 only for diff-bugs and security, so that every arm has one pass for each reviewer. Every reviewer has one pass by default since E7.
- The new arms ran on all 28 cases through a frozen build of 3da265c (0.18.0), with `--models all=<model>:<effort>`: Sonnet 5.5 medium, Sonnet 5.5 high, Opus 5.5 medium, and, for conventions, docs-and-comments and description-drift only (`--reviewers`), Haiku 5.5 medium and Haiku 5.5 high.
- The judge is Sonnet 5.5. The Sonnet arms ran with `--allow-same-judge`, so the judge model is the reviewer model there. This is a limit.
- The figures of each reviewer come from the function of `eval-report --by-reviewer`. The stored arm is scored by the same function on its pass 1 records, with the raw judge on, and its missing judge answers cost $1.17.
- Time: the duration of each reviewer query from the record. The reviewer stage of a case is its slowest reviewer pass, so the arm's stage time is the median over the cases of that slowest pass.

The noise of one pass, in raw posted-label goldens, is the larger of two measures: the difference between pass 1 and pass 2, and the mean count of goldens that one pass misses against both passes together. From the two-pass records: diff-bugs 4 and security 0 (S1), history 6 and tests 4 (the D8 measurement). The three light reviewers have no two-pass records, so their noise is set to 4, the value of the other reviewers. This is a limit.

### The rules on made-up figures

Before the figures existed, a script ran the rules on made-up figures. The current setting had 28 cases, each with 2 goldens, 4 posted findings of which 2 were real, and a cost of $1.

| Made-up arm | Stage 1 | Cheaper rule | Dearer rule |
|---|---|---|---|
| 50 goldens against 56, noise 4 | rejected | - | - |
| 53 goldens against 56, noise 4 | kept | - | - |
| The same goldens, half the cost | kept | passes | fails |
| 6 fewer goldens, half the cost | rejected | fails | fails |
| The same goldens, half the cost, precision 0.1 lower | kept | fails | fails |
| One more golden in every case, 1.2 times the cost | kept | fails | passes (upper end of R 0.40) |
| One more golden in 2 cases, 3 times the cost | kept | fails | fails (R has no upper end) |

So each rule can give each result.

## Figures

Goldens are the raw posted-label goldens that the candidates of the reviewer match. Cost is the cost of the reviewer queries. The time is the median duration of one pass of the reviewer.


### All 28 cases

| Reviewer | Arm | Goldens | Candidates | Cost | Cost / golden | Median pass time | Stage 1 |
|---|---|---|---|---|---|---|---|
| all | opus-low (S1 pass 1) | 70 | 212 | $50.69 | $0.72 | - | - |
| all | sonnet-medium | 82 | 267 | $31.96 | $0.39 | - | - |
| all | sonnet-high | 96 | 396 | $40.04 | $0.42 | - | - |
| all | opus-medium | 99 | 393 | $81.71 | $0.83 | - | - |
| all | haiku-medium | 36 | 172 | $1.92 | $0.05 | - | - |
| all | haiku-high | 34 | 220 | $3.79 | $0.11 | - | - |
| diff-bugs | opus-low (S1 pass 1) | 25 | 33 | $7.24 | $0.29 | 10 s | - |
| diff-bugs | sonnet-medium | 28 | 38 | $3.25 | $0.12 | 12 s | kept |
| diff-bugs | sonnet-high | 37 | 56 | $5.54 | $0.15 | 32.6 s | kept |
| diff-bugs | opus-medium | 41 | 68 | $10.99 | $0.27 | 25.2 s | kept |
| security | opus-low (S1 pass 1) | 7 | 14 | $6.37 | $0.91 | 5.1 s | - |
| security | sonnet-medium | 11 | 18 | $4.37 | $0.40 | 6.9 s | kept |
| security | sonnet-high | 11 | 25 | $6.14 | $0.56 | 12.3 s | kept |
| security | opus-medium | 10 | 24 | $13.98 | $1.40 | 7.3 s | kept |
| history | opus-low (S1 pass 1) | 22 | 29 | $9.74 | $0.44 | 7.5 s | - |
| history | sonnet-medium | 28 | 39 | $5.38 | $0.19 | 11.6 s | kept |
| history | sonnet-high | 40 | 61 | $6.53 | $0.16 | 27.8 s | kept |
| history | opus-medium | 25 | 36 | $11.29 | $0.45 | 12.7 s | kept |
| tests | opus-low (S1 pass 1) | 24 | 66 | $9.22 | $0.38 | 10.3 s | - |
| tests | sonnet-medium | 32 | 78 | $7.53 | $0.24 | 14.4 s | kept |
| tests | sonnet-high | 36 | 101 | $7.17 | $0.20 | 24.2 s | kept |
| tests | opus-medium | 37 | 120 | $19.30 | $0.52 | 29.7 s | kept |
| conventions | opus-low (S1 pass 1) | 9 | 14 | $5.21 | $0.58 | 5.2 s | - |
| conventions | sonnet-medium | 18 | 33 | $3.39 | $0.19 | 7.8 s | kept |
| conventions | sonnet-high | 19 | 61 | $4.30 | $0.23 | 19.1 s | kept |
| conventions | opus-medium | 16 | 50 | $8.13 | $0.51 | 12.2 s | kept |
| conventions | haiku-medium | 23 | 74 | $0.69 | $0.03 | 29.3 s | kept |
| conventions | haiku-high | 18 | 98 | $1.71 | $0.10 | 73.9 s | kept |
| docs-and-comments | opus-low (S1 pass 1) | 12 | 18 | $6.10 | $0.51 | 6.7 s | - |
| docs-and-comments | sonnet-medium | 9 | 25 | $3.81 | $0.42 | 10.9 s | kept |
| docs-and-comments | sonnet-high | 9 | 40 | $5.90 | $0.66 | 18.3 s | kept |
| docs-and-comments | opus-medium | 11 | 42 | $9.50 | $0.86 | 16 s | kept |
| docs-and-comments | haiku-medium | 9 | 35 | $0.68 | $0.08 | 21.3 s | kept |
| docs-and-comments | haiku-high | 8 | 49 | $1.13 | $0.14 | 37.3 s | kept |
| description-drift | opus-low (S1 pass 1) | 14 | 38 | $6.79 | $0.48 | 7.5 s | - |
| description-drift | sonnet-medium | 15 | 38 | $4.24 | $0.28 | 9.9 s | kept |
| description-drift | sonnet-high | 17 | 52 | $4.47 | $0.26 | 17.5 s | kept |
| description-drift | opus-medium | 20 | 53 | $8.53 | $0.43 | 11.9 s | kept |
| description-drift | haiku-medium | 14 | 63 | $0.55 | $0.04 | 21.6 s | kept |
| description-drift | haiku-high | 21 | 73 | $0.95 | $0.05 | 43.5 s | kept |

Reviewer stage, median of the slowest reviewer pass of each case: opus-low (S1 pass 1) 13 s; sonnet-medium 19 s; sonnet-high 44 s; opus-medium 33 s; haiku-medium 33 s; haiku-high 76 s

### walle and websites cases (8)

| Reviewer | Arm | Goldens | Candidates | Cost | Cost / golden | Median pass time | Stage 1 |
|---|---|---|---|---|---|---|---|
| all | opus-low (S1 pass 1) | 6 | 34 | $18.13 | $3.02 | - | - |
| all | sonnet-medium | 5 | 41 | $8.92 | $1.78 | - | - |
| all | sonnet-high | 6 | 64 | $13.00 | $2.17 | - | - |
| all | opus-medium | 6 | 62 | $26.28 | $4.38 | - | - |
| all | haiku-medium | 4 | 33 | $0.59 | $0.15 | - | - |
| all | haiku-high | 5 | 52 | $1.58 | $0.32 | - | - |
| diff-bugs | opus-low (S1 pass 1) | 4 | 4 | $2.13 | $0.53 | 10.5 s | - |
| diff-bugs | sonnet-medium | 4 | 5 | $0.89 | $0.22 | 8.2 s | kept |
| diff-bugs | sonnet-high | 4 | 5 | $1.29 | $0.32 | 17.4 s | kept |
| diff-bugs | opus-medium | 4 | 6 | $3.36 | $0.84 | 20.4 s | kept |
| security | opus-low (S1 pass 1) | 0 | 0 | $1.55 | - | 5.1 s | - |
| security | sonnet-medium | 1 | 1 | $1.03 | $1.03 | 6.9 s | kept |
| security | sonnet-high | 1 | 1 | $1.69 | $1.69 | 9.4 s | kept |
| security | opus-medium | 0 | 0 | $3.54 | - | 5.7 s | kept |
| history | opus-low (S1 pass 1) | 3 | 4 | $3.54 | $1.18 | 7.5 s | - |
| history | sonnet-medium | 3 | 6 | $1.93 | $0.64 | 10.3 s | kept |
| history | sonnet-high | 4 | 6 | $1.98 | $0.49 | 23.3 s | kept |
| history | opus-medium | 4 | 4 | $4.07 | $1.02 | 9.3 s | kept |
| tests | opus-low (S1 pass 1) | 4 | 14 | $3.49 | $0.87 | 9 s | - |
| tests | sonnet-medium | 4 | 15 | $2.14 | $0.54 | 18.7 s | kept |
| tests | sonnet-high | 4 | 20 | $2.42 | $0.60 | 18.8 s | kept |
| tests | opus-medium | 5 | 25 | $6.93 | $1.39 | 22.3 s | kept |
| conventions | opus-low (S1 pass 1) | 1 | 2 | $1.96 | $1.96 | 5.2 s | - |
| conventions | sonnet-medium | 2 | 3 | $0.81 | $0.41 | 6 s | kept |
| conventions | sonnet-high | 2 | 13 | $1.82 | $0.91 | 30.4 s | kept |
| conventions | opus-medium | 1 | 9 | $2.33 | $2.33 | 11.5 s | kept |
| conventions | haiku-medium | 2 | 9 | $0.18 | $0.09 | 21.5 s | kept |
| conventions | haiku-high | 4 | 21 | $0.64 | $0.16 | 76.4 s | kept |
| docs-and-comments | opus-low (S1 pass 1) | 3 | 5 | $2.67 | $0.89 | 12.5 s | - |
| docs-and-comments | sonnet-medium | 1 | 6 | $1.27 | $1.27 | 10.9 s | kept |
| docs-and-comments | sonnet-high | 2 | 10 | $2.07 | $1.03 | 21.8 s | kept |
| docs-and-comments | opus-medium | 2 | 11 | $3.77 | $1.89 | 16.6 s | kept |
| docs-and-comments | haiku-medium | 3 | 12 | $0.25 | $0.08 | 20.7 s | kept |
| docs-and-comments | haiku-high | 3 | 17 | $0.46 | $0.15 | 50.4 s | kept |
| description-drift | opus-low (S1 pass 1) | 2 | 5 | $2.80 | $1.40 | 9.8 s | - |
| description-drift | sonnet-medium | 4 | 6 | $0.85 | $0.21 | 7.4 s | kept |
| description-drift | sonnet-high | 3 | 9 | $1.73 | $0.58 | 22.9 s | kept |
| description-drift | opus-medium | 4 | 7 | $2.28 | $0.57 | 9 s | kept |
| description-drift | haiku-medium | 4 | 12 | $0.16 | $0.04 | 21.6 s | kept |
| description-drift | haiku-high | 4 | 14 | $0.48 | $0.12 | 73.7 s | kept |

Reviewer stage, median of the slowest reviewer pass of each case: opus-low (S1 pass 1) 15 s; sonnet-medium 19 s; sonnet-high 32 s; opus-medium 30 s; haiku-medium 33 s; haiku-high 109 s

## Stage 2

Stage 2 sent the candidates of three arms to the verifier, Sonnet 5.5 at medium effort, through `pr-review replay`: Sonnet 5.5 medium and Sonnet 5.5 high for every reviewer, and Haiku 5.5 medium for the three light reviewers. The user chose these arms after stage 1. Opus 5.5 medium did not go to stage 2: in stage 1 it raised about the same goldens as Sonnet 5.5 high (99 against 96) at two times the cost. Haiku 5.5 high did not go either: in stage 1 it was not better than Haiku 5.5 medium and cost two times as much. The stored arm is the Opus 5.5 low reviewers of S1 (pass 1), whose candidates E3 verified with the same verifier.

The posted set is the candidates whose first verifier decision passed. A replay has no escalation, no merge and no cap, so these figures compare only with each other. The cost of a reviewer is its reviewer queries and the verifier calls of its candidates. The time of a reviewer in a case is its pass and the slowest verification of its candidates; the tables give the median over the cases. The rules compare each arm with the stored arm, with the noise of one pass of stage 1.

### All 28 cases

| Reviewer | Arm | Goldens found | False posted | Precision | Cost | Cost / golden | Time (median) | Cheaper rule | Dearer rule |
|---|---|---|---|---|---|---|---|---|---|
| diff-bugs | stored | 22 | 6 | 0.786 | $10.73 | $0.49 | 16 s | - | - |
| diff-bugs | sonnet-medium | 23 | 6 | 0.793 | $6.83 | $0.30 | 17 s | passes | fails |
| diff-bugs | sonnet-high | 27 | 10 | 0.730 | $10.26 | $0.38 | 34 s | fails | fails |
| security | stored | 7 | 1 | 0.875 | $8.03 | $1.15 | 5 s | - | - |
| security | sonnet-medium | 7 | 3 | 0.700 | $6.00 | $0.86 | 7 s | fails | fails |
| security | sonnet-high | 7 | 4 | 0.636 | $8.23 | $1.18 | 15 s | fails | fails |
| history | stored | 19 | 2 | 0.905 | $12.71 | $0.67 | 8 s | - | - |
| history | sonnet-medium | 23 | 6 | 0.793 | $9.18 | $0.40 | 15 s | fails | fails |
| history | sonnet-high | 30 | 14 | 0.682 | $12.00 | $0.40 | 36 s | fails | fails |
| tests | stored | 17 | 13 | 0.567 | $18.64 | $1.10 | 29 s | - | - |
| tests | sonnet-medium | 24 | 17 | 0.585 | $17.13 | $0.71 | 21 s | passes | fails |
| tests | sonnet-high | 28 | 26 | 0.519 | $19.11 | $0.68 | 29 s | fails | passes |
| conventions | stored | 8 | 3 | 0.727 | $5.92 | $0.74 | 5 s | - | - |
| conventions | sonnet-medium | 16 | 9 | 0.640 | $6.33 | $0.40 | 10 s | fails | fails |
| conventions | sonnet-high | 17 | 18 | 0.486 | $11.07 | $0.65 | 25 s | fails | fails |
| conventions | haiku-medium | 18 | 26 | 0.409 | $8.59 | $0.48 | 35 s | fails | fails |
| docs-and-comments | stored | 11 | 3 | 0.786 | $8.14 | $0.74 | 9 s | - | - |
| docs-and-comments | sonnet-medium | 9 | 6 | 0.600 | $6.19 | $0.69 | 14 s | fails | fails |
| docs-and-comments | sonnet-high | 8 | 17 | 0.320 | $9.51 | $1.19 | 25 s | fails | fails |
| docs-and-comments | haiku-medium | 7 | 11 | 0.389 | $4.09 | $0.58 | 25 s | fails | fails |
| description-drift | stored | 9 | 8 | 0.529 | $9.36 | $1.04 | 12 s | - | - |
| description-drift | sonnet-medium | 14 | 11 | 0.560 | $7.89 | $0.56 | 14 s | passes | fails |
| description-drift | sonnet-high | 13 | 9 | 0.591 | $8.57 | $0.66 | 22 s | passes | fails |
| description-drift | haiku-medium | 11 | 9 | 0.550 | $5.37 | $0.49 | 27 s | passes | fails |

### walle and websites cases (8)

| Reviewer | Arm | Goldens found | False posted | Precision | Cost | Cost / golden | Time (median) | Cheaper rule | Dearer rule |
|---|---|---|---|---|---|---|---|---|---|
| diff-bugs | stored | 4 | 0 | 1.000 | $2.60 | $0.65 | 13 s | - | - |
| diff-bugs | sonnet-medium | 4 | 1 | 0.800 | $1.42 | $0.36 | 12 s | fails | fails |
| diff-bugs | sonnet-high | 4 | 1 | 0.800 | $1.58 | $0.39 | 21 s | fails | fails |
| security | stored | 0 | 0 | - | $1.55 | - | 5 s | - | - |
| security | sonnet-medium | 1 | 0 | 1.000 | $1.07 | $1.07 | 7 s | fails | fails |
| security | sonnet-high | 1 | 0 | 1.000 | $1.74 | $1.74 | 9 s | fails | fails |
| history | stored | 3 | 0 | 1.000 | $3.75 | $1.25 | 11 s | - | - |
| history | sonnet-medium | 3 | 1 | 0.750 | $3.01 | $1.00 | 14 s | fails | fails |
| history | sonnet-high | 4 | 1 | 0.800 | $3.10 | $0.77 | 24 s | fails | fails |
| tests | stored | 4 | 1 | 0.800 | $5.32 | $1.33 | 23 s | - | - |
| tests | sonnet-medium | 4 | 4 | 0.500 | $4.42 | $1.10 | 24 s | fails | fails |
| tests | sonnet-high | 4 | 4 | 0.500 | $4.69 | $1.17 | 26 s | fails | fails |
| conventions | stored | 1 | 0 | 1.000 | $2.05 | $2.05 | 6 s | - | - |
| conventions | sonnet-medium | 2 | 0 | 1.000 | $1.19 | $0.60 | 7 s | passes | fails |
| conventions | sonnet-high | 2 | 1 | 0.667 | $3.59 | $1.79 | 38 s | fails | fails |
| conventions | haiku-medium | 2 | 2 | 0.500 | $1.20 | $0.60 | 27 s | fails | fails |
| docs-and-comments | stored | 2 | 1 | 0.667 | $3.50 | $1.75 | 16 s | - | - |
| docs-and-comments | sonnet-medium | 1 | 1 | 0.500 | $1.92 | $1.92 | 13 s | fails | fails |
| docs-and-comments | sonnet-high | 2 | 6 | 0.250 | $2.92 | $1.46 | 26 s | fails | fails |
| docs-and-comments | haiku-medium | 3 | 3 | 0.500 | $1.71 | $0.57 | 24 s | fails | fails |
| description-drift | stored | 3 | 0 | 1.000 | $3.30 | $1.10 | 20 s | - | - |
| description-drift | sonnet-medium | 4 | 0 | 1.000 | $2.13 | $0.53 | 9 s | passes | fails |
| description-drift | sonnet-high | 3 | 3 | 0.500 | $3.12 | $1.04 | 24 s | fails | fails |
| description-drift | haiku-medium | 4 | 2 | 0.667 | $1.19 | $0.30 | 24 s | fails | fails |

### The choice between two arms that pass

- tests: Sonnet 5.5 medium passes the rule for a cheaper setting, and Sonnet 5.5 high passes the rule for a dearer setting. Against Sonnet 5.5 medium, Sonnet 5.5 high fails the rule for a dearer setting: its precision is 0.066 lower and the interval of its added goldens is not above zero. So tests moves to Sonnet 5.5 medium.
- description-drift: all three arms pass the rule for a cheaper setting. Against Sonnet 5.5 medium, Haiku 5.5 medium also passes it: 11 goldens against 14 (inside the noise of 4), precision 0.550 against 0.560, and a lower cost. So the rule gives Haiku 5.5 medium. Sonnet 5.5 medium is twice as fast (14 s against 27 s) and finds 3 more goldens for $2.52 more. The user weighs time, so the note gives both.

### The whole stage

The sums over the seven reviewers, before the merge across reviewers:

| Setting | Goldens | False posted | Precision | Cost (28 cases) | Stage time, median / 90th percentile |
|---|---|---|---|---|---|
| Today (Opus 5.5 low) | 93 | 36 | 0.721 | $73.52 | 33 s / 56 s |
| By the rules (description-drift on Haiku 5.5 medium) | 103 | 41 | 0.715 | $64.13 | 31 s / 56 s |
| The same, description-drift on Sonnet 5.5 medium | 106 | 43 | 0.711 | $66.65 | 26 s / 55 s |

The stage time of a case is its slowest reviewer with its verifications.

### Trades that the rules reject

These settings are cheaper or find more goldens, but post more false findings. None is faster than Opus 5.5 low, which is the fastest arm for every reviewer.

- history on Sonnet 5.5 medium: 4 more goldens and 28% less cost, but 4 more false findings (precision 0.905 to 0.793) and 7 s more.
- conventions on Sonnet 5.5 medium: 8 more goldens for $0.41 more, but 6 more false findings (0.727 to 0.640).
- security on Sonnet 5.5 medium: the same goldens and 25% less cost, but 2 more false findings (0.875 to 0.700).
- docs-and-comments on Haiku 5.5 medium: half the cost, but 4 fewer goldens and 8 more false findings (0.786 to 0.389).

### Not measured

- The escalation, the merge and the cap downstream of the new reviewers. The replay used the first verifier only.
- A judge on another model. The judge is Sonnet 5.5, the model of the Sonnet arms.
- The effect of Haiku 5.5 on refusals and on work reported as done without a check, which the design names as the reason not to use Haiku 5.5 as a reviewer.
- Whether a Sonnet 5.5 judge favours the findings of Sonnet 5.5 reviewers. The judge is Sonnet 5.5, so the eval scores the Sonnet arms with their own model. After the change, the default eval does the same for diff-bugs and tests: the eval warns and the report names the shared model. A judge of a second model family for the eval is the real fix, and a follow-up.

## Spend

Stage 1 cost $178.39 for the five arms and $1.17 for the judge of the stored arm. Stage 2 cost about $85: Sonnet 5.5 medium $28.4, Haiku 5.5 medium $17.07, Sonnet 5.5 high $39.43. About three cases were running when a window stopped and are in no result file. All runs used the plan login.

## The cost of stage 2 (estimate before the run)

Stage 2 sends the candidates of each pair that stage 1 keeps to the verifier, Sonnet 5.5 at medium effort, through `pr-review replay`. The stored arm needs no new call: E3 already verified every S1 candidate with that verifier. At $0.103 for each candidate:

| Arm | Candidates | Stage 2 cost |
|---|---|---|
| Sonnet 5.5 medium | 269 | about $28 |
| Sonnet 5.5 high | 396 | about $41 |
| Opus 5.5 medium | 393 | about $40 |
| Haiku 5.5 medium (light reviewers) | 172 | about $18 |
| Haiku 5.5 high (light reviewers) | 220 | about $23 |

All arms together cost about $149. A pair costs its candidates times $0.103.

### Spend of stage 1

The five arms cost $178.39 on the plan login, the probes included: Sonnet 5.5 medium $35.81, Sonnet 5.5 high $44.08, Opus 5.5 medium $86.39, Haiku 5.5 medium $4.85 and Haiku 5.5 high $7.26. The judge of the stored arm cost $1.17. About three cases were running when the principal stopped a window; their cost is in no result file. The probe of Opus 5.5 medium gave an estimate of $54, but the arm cost $86: the probe cases do not predict a model with a different spread of cost over the cases.

The Sonnet arms used about 2 points of the five-hour plan window for each dollar, about two times the Opus rate.

## Limits

- Stage 1 gives raw goldens and no precision. An arm that raises more goldens also gives more candidates, and the verifier can drop more of them.
- One run of each arm, on 28 cases. The noise of one pass is from two reviewers in S1 and two in D8; the light reviewers have an assumed noise.
- The judge is Sonnet 5.5, the model of two arms (`--allow-same-judge`). A judge can favour findings in its own style.
- The walle and websites cases hold only 6 posted-label goldens in all, so they do not separate the arms.
- The stored arm ran on the tool of S1 (f8f5b38) and the new arms on 3da265c. The reviewer prompts and the dedupe are the same in both builds, apart from the passes in the frontmatter, which E7 set to one; the verifier defaults differ, but stage 1 does not call the verifier.
