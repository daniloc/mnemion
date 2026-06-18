---
url: https://accord.exchange/how-to-build-software/structuring-code
title: Structuring code
license: CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/)
metadata:
  author: Danilo Campos
---

Software is a living artifact. It is never completed, only abandoned. There will always be further desires, goals and refinements to address.

Thus, building software is the art and skill of structuring projects to ease maintenance, refinement, and understanding.

## Creating the boundaries between code

When code addresses many different problems in a single file, it makes understanding and changes more expensive.

Let's imagine a simple program: it fetches a number from the internet and draws it on the screen.

Ideally, this program's project code is structured to separate different responsibilities into distinct files. Concretely, this can mean the file for drawing numbers is separate from code for connecting to the network, while code for interpreting the responses from the network lives in a third file. At a high level, this notion is called *separation of concerns*.

Different languages might have further conventions for this kind of isolation. These allow *encapsulation*: the process of concealing the details of code inside a boundary within a file. It can be valuable to learn about the conventions in the programming language your project is targeting.

Metaphorical "objects" are a common programming convention, so in our program, let's imagine an object that handles drawing numbers to the screen. There might be many details about graphics that we don't want other components to be concerned with. So we "encapsulate" that detail.

With the details hidden away, it becomes necessary to advertise what you can do with it. The component must provide a contract, or *interface*, that specifies what its consumers can send and receive. This is called *abstraction*. We might abstract our drawing code, concealing the details, and offering just a function that accepts a number as an input. This allows the underlying details to be changed at will, so long as the outer, abstracted contract is still fulfilled: "talk to me to draw a number."

This hygiene pays serious rent: cleanly separated code makes it much easier to figure out why a program isn't working the way you hoped. Defects can be quickly isolated when you know exactly where to look. It also makes it possible to swap out the components you build with better replacements down the road.

You can build a quick prototype without caring about any of these ideas. But it's much harder to build something that's both complex and durable without a clear picture of where one component ends and another begins.

## Combining components

In isolation, an object that draws numbers to the screen is not very useful. Which numbers? Where do they come from?

With components nicely packaged, the job becomes combining them, in a process called *composition*. Sometimes this means piping components together in a linear chain. But composition can also take the form of embedding one component in another.

We might create a simple loop object, running every five minutes, which contains:

- network object: check the internet for a new number
- parsing object: read the new value returned from the network object
- screen drawing object: draw the new value extracted by the parser

This loop runs continuously. If we want, we can add additional components:

- a sound output object that alerts on new values
- a button-handling object that allows an instant refresh

Composition is an essential skill because time is finite. You probably don't want to write every component you need from scratch. Instead, vast libraries of components cover common needs. You'll compose these components with your own creations, creating a stack of functionality that addresses all the problems your program has to solve.

## Dependencies: other people's programming

Where you get your external components matters.

Sometimes, if you're building on a platform funded by a corporate business model, you'll have a vast library of components that comes with your library or operating system. These components are commercially maintained and hopefully well documented.

But an entire universe of open source projects also exists. These might be aggressively maintained, or abandoned years ago.

The dependencies you choose influence your project. You might introduce bugs carried by their code, or you might save yourself days of effort solving a hard problem. The legal status of external code is also important: some code comes with legal responsibilities that impact the ways you're allowed to use it.

Every dependency is a relationship, so evaluating them can be an important decision. Some projects can change course dramatically, introducing new versions that you can't use without adapting your code.

This is not to say that such dependencies should be avoided. Every project has some, and a few are so common they're not worth thinking about. Dependencies bring expertise and proven solutions into your project. It's just worth understanding what you're inviting inside.

## Version control

Modern programs have a hidden structure: shape over time.

As your program evolves, you will add new components or elaborate on existing ones. As these additions are completed and validated, using version control—git is the accepted standard—allows you to *commit* these changes with a message about their purpose.

This discipline is essential. You'll sometimes need to throw away changes, returning to a known-good state in the program. Version control makes this trivial. Sometimes you'll want to return to an earlier stage of the program so you can reference a direction that was discarded. Version control is a powerful undo/redo manager, but it's also a long-term reference about your decisions and progress.
