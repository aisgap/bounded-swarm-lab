export const USE_CASE_PRESETS = Object.freeze([
  Object.freeze({
    id: "decision-memo",
    title: "Decision memo",
    description: "Compare supplied options and produce an evidence-aware recommendation.",
    objective:
      "Using only the facts below, produce a decision memo recommending one option for [decision]. Options: [option A, option B, option C]. Known facts and constraints: [paste facts, budget, deadline, dependencies, and uncertainties]. Do not introduce external facts.",
    acceptanceCriteria:
      "Compare every option against the stated constraints; distinguish facts from assumptions; identify material uncertainty and risks; recommend one option with reasons; include mitigations and the next three actions. If evidence is insufficient, state what is missing instead of inventing support.",
  }),
  Object.freeze({
    id: "sop-improvement",
    title: "SOP improvement",
    description: "Turn a supplied process into a clearer, safer operating procedure.",
    objective:
      "Using only the process description below, produce an improved SOP for [process]. Current steps: [paste steps]. Known pain points: [delays, errors, handoff issues]. Required constraints: [owners, timing, approvals, systems]. Preserve mandatory controls and flag missing information.",
    acceptanceCriteria:
      "Provide ordered steps, named roles, inputs and outputs, decision points, exception handling, and a rollback or escalation path. Address each stated pain point without weakening mandatory controls. Include a short verification checklist and clearly label assumptions.",
  }),
  Object.freeze({
    id: "release-readiness",
    title: "Release readiness",
    description: "Create a bounded readiness plan and conditional go/no-go recommendation.",
    objective:
      "Using only the release facts below, create a readiness plan for [release]. Scope: [changes]. Evidence available: [tests, reviews, monitoring]. Known risks: [risks]. Deadline and rollback constraints: [details]. Do not claim checks were completed unless explicitly stated.",
    acceptanceCriteria:
      "Separate completed evidence from required checks; rank risks by impact and likelihood; define owners and pass or fail gates; include deployment, monitoring, rollback, and communication steps; give a conditional go or no-go recommendation with unresolved blockers.",
  }),
  Object.freeze({
    id: "incident-review",
    title: "Incident review",
    description: "Build a blameless review and remediation plan from a supplied timeline.",
    objective:
      "Using only the incident information below, create a blameless review for [incident]. Timeline: [events]. Observed impact: [impact]. Known contributing conditions: [facts]. Existing safeguards and constraints: [details]. Preserve uncertainty and do not invent a root cause.",
    acceptanceCriteria:
      "Provide a factual timeline; separate direct and contributing causes from hypotheses; identify detection and response gaps; propose prioritized corrective actions with owners and verification evidence; include follow-up checkpoints and explicitly list unanswered questions.",
  }),
]);
