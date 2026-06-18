---
url: https://accord.exchange/how-to-build-software
name: how-to-build-software
title: How to build software
description: An accord for building software with AI assistance. Establishes shared vocabulary and principles for structuring code, structuring data, and managing the strategic risks of going from zero to one. Use when building projects to maintain strong foundations.
disable-model-invocation: true
license: CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/)
metadata:
  author: Danilo Campos
---

This is an *accord*: an orientation document that gives humans and LLM agents common language and expectations for achieving goals together. Accords are packaged as Agent Skills for agents, and quick-reference HTML guides for humans.

This accord covers three domains essential to building software.

## Structuring code

Software is never completed, only abandoned. Structure must be planned carefully to ease maintenance, refinement, and understanding. The key ideas:

- **Separation of concerns**: different responsibilities belong in different containers.
- **Encapsulation**: conceal a component's details inside a boundary.
- **Abstraction**: expose a contract, or *interface*, that specifies what consumers can send and receive.
- **Composition**: combine components by chaining or nesting them.
- **Dependencies**: external components are relationships, not free building blocks. Evaluate what you're inviting inside.
- **Version control**: git captures your program's shape over time. Commit at every validated step.

See [Structuring code](references/structuring-code.md).

## Data is destiny

Structuring data is at least as consequential as structuring code.

- **Models** define the shape of data. They are contracts that describe what components can expect to input and output.
- **State** is the concrete value of that data at a given moment. Where it lives, whether it's duplicated, and its overall source of truth..

Store truth once, then compute its consequences.

See [Data is destiny](references/data-is-destiny.md).

## Creating a strong first draft

Writing software is a gamble — an investment of time against uncertain returns. Manage that risk in stages:

1. **Prototype** the scariest unknowns first. Sloppy code, ugly interfaces. Confirm feasibility before building further.
2. **Vertical slice**: prove that every layer of your stack can work together in one narrow path. Something complex that works must emerge from something simple that worked.
3. **Scope narrowly**, especially when using LLM tools. The ability to generate fast can lock you into directions that conceal problems.
4. **Iterate**: refine repeatedly, commit what works, discard what doesn't.
5. **Get your work in front of real people**. The real test is whether it solves a problem.

See [Creating a strong first draft](references/creating-a-strong-first-draft.md).