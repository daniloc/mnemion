---
url: https://accord.exchange/how-to-build-software/creating-a-strong-first-draft
title: Creating a strong first draft
license: CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/)
metadata:
  author: Danilo Campos
---

Writing software is a gamble.

*Can I invest time and energy to solve a problem in a way that creates a positive return?*

Which means that writing software is about managing time risk. You want to find out as quickly as possible:

- Is it actually possible to solve the problem I care about using code and automation? Some problems resist automation.
- Is the set of tools and experience I have compatible with the problem I want to solve? Some problems are easy for some teams, and hard for others, based entirely on existing skills and experience.
- Does the premise of my program actually lend itself to convenience and usability? Some tools are so ungainly that their power becomes hard to access.

## Start with prototyping

The biggest risk in building software is that what you want to achieve is simply not possible in the ways you're imagining.

De-risking your project starts by interrogating your most ambiguous problems and writing code to test their solutions.

At the *prototype* stage, all the rules and ideas for making good software go out the window. Sloppy code is fine. Ugly interfaces are great. What is most important is confirming that what is most uncertain in your project is actually achievable.

Maybe there's a file format you need to be able to work with. A prototype might try to parse an existing, known-good file into a data model, make some changes, and write it back out, letting you test that this actually loads correctly in another program. If doing this reliably is necessary to your program but not actually possible, then there's no point building the rest.

Maybe risk lives in the user interface of your project itself. In that case, you could build a version of that interface that lets you test and refine the details of its premise, using fake data under the hood. This lets you focus on things like appearance, behavior and timing. Again, if your idea falls apart here, you can abandon it without having burned time on unnecessary, low-risk components that no longer matter.

Prototype code can be sloppy, so it's best used as a reference for future work, rather than a foundation.

## Vertical slice: an ambitious but achievable test

Once the scariest parts of the program have been validated, it's safe to move on to real code that might someday get out into the world.

In game design, this first swing is called a *vertical slice* and it's an idea that's broadly applicable to all software. Vertical slicing is an expression of Gall's Law: something complex that works must emerge from something simple that worked.

In a vertical slice, you think through the entire stack of components that need to work together in order for your project to work. Instead of covering the entire breadth of your program, you think about a narrow slice of its *depth*. If you can't get all these systems to work together, your program doesn't have a future. For example:

- User interface
- Data model and state management
- Network access
- Saving to disk

A program that fetches a number from the internet and draws it to the screen is an excellent vertical slice of what could be a complicated problem. From that basis it's possible to draw more numbers, or introduce controls that allow the user to explore entire data sets.

Building a narrow test of all these systems working together lets you more quickly validate that your approach is sound. But more importantly, the vertical slice gives you a valuable reference to use as you expand the breadth of your project. Every layer will have a validated first step to build upon.

## Scoping and iterating

With risks defeated, the job becomes about adding functionality and iterating. Things can go off the rails quickly at this point: you must not try to boil the ocean. Especially with LLM tools, this boiling is more possible than ever before. But it might lock you into a direction which conceals subtle problems and makes the program rigid against solving them. This may be the larger risk of LLM development for the ambitious creator of software.

So *scoping* what you do next is essential. Prototyping and vertical slicing are themselves scoping exercises. Think about what your program is missing in terms of individual features and abilities. Scope your work narrowly to adding these one at a time, validating each the same way as your initial explorations.

*Iteration* is the most essential job from here. With a strong foundation under your program, what matters is refining your solution multiple times. You will never get things exactly right on the first try.

So the game becomes about understanding what you can learn from a given iteration and working forward from there.

Version control becomes essential here: sometimes an iteration will be a dead end and you'll want to return to a state in your program that was closer to your ambitions. Using git at the conclusion of every successful iteration to capture and describe what you got right is key.

## The longer adventure

Again, software is abandoned, not completed. There is no hard and fast rule about when your project is "done."

But one thing that helps everything from hobby projects to startup projects is simple: get your work in front of real people.

The real test of what you've built is whether it solves a problem. Maybe you're the only audience, or maybe loads of people can benefit from it. Either way, you have to check constantly that what you've built actually helps. You might be surprised at what people find useful—or confusing. Getting those signals early will help you build the best stuff, giving you a more concrete direction for future iteration.
