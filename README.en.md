# Codex Engineering (CE)

An engineering workflow Skill for Codex, from the first idea to verified delivery.

CE helps Codex turn a request into a workable plan, implement it within your project's existing rules, and check the result through actual use. It connects requirements, research, design, debugging, verification, and acceptance testing in an AI coding workflow. Saved decisions and evidence provide context continuity when work resumes.

[中文](README.md) · [Install](#get-started) · [Getting started](START-HERE.md) · [Use cases](USE-CASES.md) · [FAQ](FAQ.md) · [Architecture](ARCHITECTURE.md) · [Validation](PUBLIC-VALIDATION.md)

## When to use CE

### From an idea to a plan

- You have an idea, but the requirements are incomplete. CE guides Codex to identify users, usage scenarios, success criteria, and consequential tradeoffs so the goal can be implemented and tested.
- A new feature needs research before you choose a solution. CE guides Codex to identify unknowns that could change the decision, then consult official documentation, public products, and established resources. When product value is unclear, the methods include user, market, and competitor research.
- Several existing solutions look suitable. CE helps compare them against the product's stage, current structure, runtime environment, and maintenance cost. It favors reuse of existing project capabilities, platform features, and suitable open source resources; a local demo can use a solution appropriate for local use.
- A detailed plan has drifted from an agreed goal. CE guides Codex to check the user's decisions and original project documents, separate settled choices from suggestions and unknowns, and reassess the parts affected by a conflict.

### Design, implementation, and debugging

- A page looks plausible, but the user journey and feedback are unclear. CE brings in interaction design methods and established references, reuses project components, and considers loading, success, failure, and exception states. Source checks and an overall UI review support the assessment.
- Adding a feature could break existing behavior. CE guides Codex to read the current components, interfaces, permissions, and data rules first, preserve user changes and working features, and implement within the existing structure.
- A bug keeps returning after fixes and retries. CE starts with reproduction, logs, and original evidence, then helps choose investigation, repair, live diagnostics, or trace analysis. For an old concern, the first step is to establish whether the problem still exists.

### Verification and delivery

- Checks keep expanding, or passing checks keep running again. CE defines required checks and stopping conditions and identifies reusable evidence. Its local runner uses input fingerprints and receipts to detect repeated execution. New facts can justify extending the affected scope.
- Automated checks pass, but the business result is uncertain. CE retains overall UI review and acceptance testing with real accounts, configuration, and entry points: enter data, click, submit, wait, and verify outcomes such as saving and querying.
- A changed requirement may affect completed features. CE's feature records connect requirements, implementation, checks, and acceptance evidence. They track source changes and record implementation, successful verification, and release as separate states.

### Manage effort and continue existing work

- Project history has grown too large to reread each time. CE organizes required sources, optional material, valid decisions, and pending work for the current task. Saved state supports resuming interrupted work; changed sources require another check.
- A file read or a small wording change triggers too much process. CE keeps a short path for simple reads, clear small changes, and still-valid decisions, with work limited to the affected parts.
- Multiple agents repeat work or have unclear file ownership. CE's collaboration methods define responsibilities, context, interfaces, and completion conditions. The lead agent integrates the results; model recommendations use supported capabilities and task risk while preserving the user's settings.
- Token usage, service fees, and waiting time are hard to distinguish. CE can summarize model usage from native records and track business costs and elapsed time separately, including failures and retries. Provider experiments run through CE's experiment entry point check cumulative calls and budget; missing data stays unknown.
- Switching projects causes configuration or records to be mixed up. CE's project bindings check the actual directory, version, documents, and check entry points. Each project retains its own rules and records, and private local bindings stay outside the public package.
- An upgrade might overwrite custom work or lose history. CE's upgrade and rollback tools check versions, backups, configuration compatibility, and later edits. Conflicts preserve existing content, and recorded backups support recovery while project history is retained.

Codex chooses the applicable methods for each task. Local tools handle deterministic checks such as configuration matching, file identity, registered checks, and records. The [architecture](ARCHITECTURE.md) maps these scenarios to their implementation; the [validation record](PUBLIC-VALIDATION.md) describes the tested scope for version 0.5.14.

## Get started

### Ask Codex to install it

Copy this request into Codex:

```text
Please install CE: https://github.com/Heartzz10/codex-engineering
Read the repository's START-HERE.md first, and check Node.js 22+ and any existing CE installation.
For a first installation, obtain the repository in a local directory that will be kept, run scripts/install-ce.mjs, and verify the installed version and entry point.
If CE is already installed, preserve custom rules, runtime bindings, project configuration, and history. Back up and check compatibility, then upgrade in the existing location without installing a duplicate Skill with the same name.
Keep runtime bindings and records in private local directories. When finished, tell me how to enable CE in my project.
```

You need a working Codex installation and Node.js 22 or newer. Codex can check the environment for you. The core workflow requires no Jev key; Jev is an optional experimental module and is off by default for everyday use.

### Install from the command line

With Git and Node.js 22+ available, run these commands where you intend to keep CE:

```sh
git clone https://github.com/Heartzz10/codex-engineering.git
cd codex-engineering
node scripts/install-ce.mjs
```

This is the first-install path. The installer verifies the public file manifest, copies the CE Skill to `~/.agents/skills`, creates private local runtime bindings, and checks the entry point. No npm installation is required. Keep the cloned CE directory: the installed Skill uses its runtime code.

If the installer finds an existing CE installation, it preserves the files and stops. Use the request above to have Codex check compatibility and upgrade in the existing location, retaining customizations, private configuration, and history.

You can also [download the ZIP](https://github.com/Heartzz10/codex-engineering/archive/refs/heads/main.zip), extract it into a directory you will keep, and give Codex the installation request together with the extracted directory.

### Use it in your project

Open your project in Codex, start a new chat, and send:

> Use $codex-engineering to add search to this library. Follow the existing decisions, choose a solution suited to this project, implement it, and verify it through actual use.

Restart Codex if needed for the new Codex skill to appear. The [getting started guide](START-HERE.md) covers installation checks, project bindings, and updates.

## How it works

CE combines Codex's interpretation of natural language with local tools and project records:

| Part | Responsibility |
| --- | --- |
| Skill and methods loaded as needed | Identify the task and guide requirements, research, design, debugging, and acceptance work. |
| Local tools and rules | Check configuration, run registered checks, calculate fingerprints, and save receipts. |
| Project sources and records | Connect decisions with implementation, verification, and pending work so valid evidence can be reused. |

CE uses evidence-based decisions, verification suited to the affected scope, selective context loading, and explicit stopping conditions. Debugging methods draw on Pstack protocols; HTML and accessibility checks use html-validate and axe-core. Interaction design can consult established design systems and platform guidance when relevant.

Codex makes semantic and product judgments using the Skill and project facts. Local rules apply to registered checks run through CE within their declared scope. Real account behavior, remote state, and business outcomes require actual operation and review. The [architecture](ARCHITECTURE.md) explains these responsibilities, sources, and limits.

## License

CE-authored code is available under the [MIT license](LICENSE), allowing use, modification, and commercial use with the copyright and license notice retained. Bundled third-party resources follow [their own licenses](THIRD_PARTY_NOTICES.md).
