# Agent Harness Engineering: A Deep Dive

*For a product designer learning to be an agentic engineer. Written to be dense, not long. May 28, 2026.*

---

## The one idea everything hangs off

**Agent = Model + Harness.** The model is the weights. The harness is everything else you wrap around it so it can actually finish a job: the system prompt, the tools, the context rules, the hooks, the sandbox, the sub-agents, the feedback loops, the recovery paths. Viv Trivedy coined the term and put it bluntly: if you're not the model, you're the harness.

A raw model isn't an agent. It becomes one the moment a harness gives it state, tool execution, feedback, and constraints. Simon Willison's version of the loop is the cleanest: an agent runs tools in a loop to reach a goal. The craft is in designing both the tools and the loop.

Here's why you should care as someone *building* with agents rather than training them: **the gap between what a model can do and what you watch it do is mostly a harness gap, not a model gap.** That's not a slogan, it's measured. On Terminal-Bench 2.0, Claude Opus 4.6 scores about 58% inside Claude Code and about 80% inside a different custom harness (ForgeCode). Same model. One team moved a coding agent from roughly top-40 to top-5 by changing only the harness. So the loud debate about which model is smartest is arguing about maybe a third of the system.

> Your project cheatsheet already does a slice of harness work: "default to Sonnet, escalate up, delegate down" is model routing, one of the harness's orchestration decisions. The harness is the rest of that picture.

---

## Two mental models, and you want both

The field has two complementary lenses. Osmani and Trivedy describe the harness from the *builder's* side (what components exist and why). Birgitta Böckeler, on Martin Fowler's site, describes it from the *user's* side (how you steer an agent you didn't build). Learn both; they don't compete.

### Lens 1 — Anatomy and the ratchet (the builder view)

Work backwards from behaviour. Start with a thing the model can't reliably do on its own, then add the smallest harness piece that delivers it. Anthropic states the rule as: every harness component encodes an assumption about what the model can't do alone. If you can't name the behaviour a component exists for, delete it.

The discipline's core habit is **the ratchet**: treat every agent mistake as a permanent signal, not a bad-luck retry. Agent merged a commented-out test? Three things change. A line in `AGENTS.md` ("delete or fix tests, never comment out"). A pre-commit hook that greps the diff for skipped tests. A reviewer sub-agent that flags it. You only *add* a constraint when you've seen a real failure, and you only *remove* one when a better model made it pointless. Every line in a good rulebook traces to something that actually went wrong. This is why you can't download someone else's harness: it's shaped by *your* failure history.

### Lens 2 — Guides and sensors (the user view)

Böckeler reframes the harness as a control system with two halves:

- **Guides (feedforward)** steer the agent *before* it acts: `AGENTS.md`, skills, reference docs, codemods, language servers. They raise the odds of a good first attempt.
- **Sensors (feedback)** observe *after* it acts and feed corrections back in: linters, type checkers, tests, AI code review. The trick is making sensor output legible to the model. A custom lint message that includes the fix instruction is, in her words, a positive kind of prompt injection.

Feedforward-only gives you an agent that never learns if its rules worked. Feedback-only gives you an agent that keeps repeating the same mistake. You need both, in a loop.

She adds a second axis that's genuinely useful:

- **Computational** controls are deterministic and cheap: tests, linters, type checks, structural analysis. Run them on every change.
- **Inferential** controls use a model for semantic judgment: AI review, LLM-as-judge. Richer, slower, non-deterministic. Run them where judgment actually matters.

And a timing principle borrowed straight from continuous delivery: **keep quality left.** Cheap fast checks run before commit; expensive ones (mutation testing, broad architectural review) run post-integration. The earlier a sensor fires, the cheaper the fix.

---

## The primitives (what's actually in a harness)

Each one exists to deliver a behaviour the model can't manage alone.

| Primitive | Behaviour it unlocks | Notes |
|---|---|---|
| Filesystem + Git | Durable state beyond the context window | The foundational, boring, underrated one. Most other primitives point back at it. |
| Bash + code execution | A general-purpose tool instead of pre-built ones | Hand it a kitchen, not one gadget. Most tasks collapse to a few CLI calls. |
| Sandbox | Safe, parallel, reproducible execution | Allow-list commands, isolate the network, ship good defaults (runtimes, test CLI, headless browser). |
| Memory + search | Continual learning across sessions | `AGENTS.md` reloaded each start; web search and MCP tools bridge the training cutoff. |
| Context management | Performance over long contexts | Three moves: compaction, tool-output offloading to disk, and skills with progressive disclosure. |
| Hooks | Enforcement, not suggestion | Run on lifecycle events. Block `rm -rf`. Run typecheck after every edit. **Success is silent, failure is verbose.** |
| Long-horizon control | Work that spans many context windows | Ralph loops, planner/generator/evaluator splits, sprint contracts. |

Two things worth internalizing:

**Context rot is real.** Models get worse as the window fills, well before the hard limit. A multi-agent session at turn 40 can be *actively worse* than a focused single-agent session at turn 5, because coherence degrades. More agents and more steps aren't free; the extra tokens are coordination overhead. Don't reach for multi-agent because it sounds sophisticated.

**`AGENTS.md` is your highest-leverage surface** because it lands in the system prompt every single turn. Keep it short (HumanLayer keeps theirs under 60 lines). Every line competes for the model's attention, so more rules make each rule matter less. Treat it as a pilot's checklist, not a style guide. Same logic for tools: ten focused tools beat fifty overlapping ones, because the model can hold the menu in its head.

---

## The deeper frame: this is cybernetics

If you want the intellectual spine of the field, it's control theory, and the practitioners know it. Böckeler calls the harness a cybernetic governor: feedforward plus feedback regulating a system toward a desired state. The lineage runs back to Watt's steam-engine governor and Norbert Wiener. A sensor plus an actuator closing a loop, just at a new layer.

The load-bearing idea is **Ashby's Law of Requisite Variety**: a regulator needs at least as much variety as the system it controls, and it can only regulate what it has a model of. An LLM can produce almost anything, which is exactly what makes it hard to harness. So committing to a *topology* (a known service shape: CRUD-API-on-JVM, event-processor-in-Go, data-dashboard-in-Node) is a deliberate variety-reduction move. Narrow what the agent might build, and a comprehensive harness becomes achievable. That's the logic behind Böckeler's idea of reusable **harness templates**, and why teams may start picking tech stacks partly by which harness already exists for them.

This is the part most "prompt engineering" content misses entirely. Worth sitting with.

---

## The academic lineage (where the patterns come from)

The industry vocabulary is new; the techniques sit on a real research base. If you want to read primary sources rather than blog posts, start here.

| Pattern in the harness | Research root |
|---|---|
| The reason → act → observe loop | **ReAct** (Yao et al., 2023), arXiv:2210.03629 |
| Learn from your own failures via self-critique | **Reflexion** (Shinn et al., 2023), arXiv:2303.11366 |
| Chain-of-thought as a reasoning substrate | Wei et al., 2022, arXiv:2201.11903 |
| Generator separated from evaluator | The "LLM-as-judge" line; agent-as-judge follow-ups (2025–26) |
| Agents that accumulate strategy over time | **EvolveR** (self-evolving agents, 2025), arXiv:2510.16079 |
| Self-evaluation is unreliable; verify explicitly | "Verify Before You Commit" self-auditing (2026), arXiv:2604.08401; rubric-guided verification, arXiv:2601.15808 |

Two findings from this literature matter for how you build:

1. **Agents skew positive when grading their own work.** This is documented, and it's the entire reason Anthropic's long-running harness separates the generator agent from the evaluator agent. Don't let an agent be its own judge on anything subjective.
2. **A correct final answer can hide broken reasoning.** Faithful-reasoning work shows agents reach right answers through invalid steps, and that bad intermediate state gets written to memory and propagated. Sensors that only check the final output miss this. It argues for checking trajectories, not just results.

For the landscape as a whole, the 2026 survey *Agentic AI: Architectures, Taxonomies, and Evaluation of LLM Agents* (arXiv:2601.12560) breaks agents into perception, brain, planning, action, tool use, and collaboration. Good map if you want one paper to orient from.

---

## The frontier (what's genuinely unsolved)

This is where the cutting-edge work is right now.

**The behaviour harness is the open problem.** Regulating *internal quality* (maintainability, architecture) is largely solved, because we already have linters, type checkers, structural tests, fitness functions. Regulating *functional correctness* (does it do the right thing?) is not. Today most people feed a spec forward and check AI-generated tests come back green, which puts a lot of faith in test suites the AI also wrote. Böckeler is direct that this isn't good enough yet. The "approved fixtures" pattern helps in some areas. No one has a general answer.

**Self-improving harnesses.** The next step past the manual ratchet: agents that read their own execution traces, spot recurring harness-level failures, and patch the harness itself (a new rule, a new sensor). Trivedy names this as a near-term frontier. It's where the harness stops being static config.

**Just-in-time harness assembly.** Today you pre-configure tools and context at startup. The frontier is a harness that dynamically assembles exactly the right tools and context for the task in front of it. Osmani's framing: at that point the harness stops being config and starts looking like a compiler.

**Harness-as-a-Service (HaaS).** The build surface is shifting from raw LLM APIs (you get a completion, build everything yourself) to harness APIs (you get a runtime: loop, tools, context management, hooks, sandbox already wired). The Claude Agent SDK, Codex SDK, and OpenAI Agents SDK all point this way. Practical upside for you: you don't rebuild an agent from scratch every time something breaks, you tune a well-factored config surface.

**Evals are quietly load-bearing and quietly noisy.** Anthropic's own work on quantifying infrastructure noise in agentic coding evals found that infrastructure config alone can swing benchmark scores by several points, sometimes more than the gap between top models on the leaderboard. So be skeptical of harness comparisons that don't control for the environment.

**Proof the ceiling is real.** An OpenAI team reported a codebase of over a million lines where no line was written by a human hand, roughly 1,500 PRs merged by three engineers over five months. Their stated conclusion is the tell: their hardest problems are now designing environments, feedback loops, and control systems, not the model.

One nuance to hold onto: **harnesses don't shrink as models improve, they move.** Opus 4.6 killed off "context anxiety" (Sonnet 4.5 used to wrap up early near its context limit), so a whole class of mitigation scaffolding became dead code. But better models unlock harder tasks with *new* failure modes, which need *new* scaffolding. The ceiling rose; the scaffolding relocated to the new ceiling.

---

## What to actually do (you're learning, so here's the path)

You don't need to build a perfect harness. You need a v0.1, because you can't iterate on something that doesn't exist. Trivedy's line is the right starting posture: good agent-building is iteration, and you can't iterate without a v0.1.

A concrete progression:

1. **Start with a coding agent you didn't build** (Claude Code, Cursor, Codex). You're learning the user harness first. That's the right entry point for someone coming from design.
2. **Write a tiny `AGENTS.md`.** Under 20 lines. Only rules you've personally watched the agent break. Add to it via the ratchet, never by brainstorming rules you imagine you'll need.
3. **Add one computational sensor.** A pre-commit hook that runs your linter and type check, and feeds failures back. Make success silent and failure verbose.
4. **Add one guide as a skill** for a task you do repeatedly (how you bootstrap a project, how you want reviews done).
5. **When a task gets too big for one window,** introduce a plan file on disk and a separate evaluator pass. Don't self-evaluate.
6. **Only then reach for multi-agent**, and only if you can name the coherence problem it solves. Default to the smaller, more focused setup.

Your design background is an advantage here, not a gap. A harness is an interface between a human's intent and a non-deterministic system, and most of the work is exactly the stuff you already do: anticipating failure, designing legible feedback, deciding where the human's attention should go. Böckeler's framing of the human's job names it directly: a good harness shouldn't try to eliminate human input, it should direct it to where it matters most. That's interaction design.

---

## Primary sources

- Addy Osmani, *Agent Harness Engineering* — addyosmani.com/blog/agent-harness-engineering/
- Birgitta Böckeler, *Harness engineering for coding agent users* — martinfowler.com/articles/harness-engineering.html
- Birgitta Böckeler, *Maintainability sensors for coding agents* — martinfowler.com/articles/sensors-for-coding-agents.html
- Viv Trivedy, *Anatomy of an Agent Harness* and *Harness-as-a-Service* — vtrivedy.com
- Anthropic Engineering, *Effective Harnesses for Long-Running Agents* (Nov 2025) and *Harness Design for Long-Running Application Development* (Mar 2026) — anthropic.com/engineering
- Anthropic, example harness primitives repo — github.com/anthropics/cwc-long-running-agents
- HumanLayer, *Skill Issue: Harness Engineering for Coding Agents* — humanlayer.dev
- LangChain, *The Anatomy of an Agent Harness* — blog.langchain.com
- OpenAI, *Harness engineering: leveraging Codex in an agent-first world*
- Stripe, *Minions: one-shot end-to-end coding agents* — stripe.dev/blog
- Curated list: github.com/AutoJunjie/awesome-agent-harness

**Foundational papers:** ReAct (2210.03629), Reflexion (2303.11366), Chain-of-Thought (2201.11903), Agentic AI survey (2601.12560).
