---
url: https://accord.exchange/how-to-build-software/data-is-destiny
title: Data is destiny
license: CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/)
metadata:
  author: Danilo Campos
---

Structuring code is the obvious part of making a program, but *structuring data* might be even more consequential.

The way your program sees data will impact everything.

Let's return to our example of a simple program that fetches a number from the internet and draws it to the screen.

What happens if we later also want to fetch a text label for that number? Every component may be affected:

- What we request from the network
- How we interpret the responses
- What we draw to the screen

So if our assumptions about the data our program handles are too rigid—"we will only care about a number"—then our program will be correspondingly rigid as our needs change.

## Models: a map that becomes the territory

A *model* is the definition of data held by a program.

All data in a program will be shaped by the model. Let's look at some simple models.

In the first version of our program, the model was simple but quite inflexible:

- `number`: a value drawn to the screen

The moment we need more than just a number in our program, we're in trouble.

So the next version of the model must become a container for multiple values, to account for our needed label content.

- `statistic`:
    - `labelText` (the text that describes our number)
    - `value` (the number we display)

Now we can handle multiple layers of information across all the components of the program responsible for this data. But a hidden advantage has just entered the equation: we are now using a *layer of indirection*. Instead of directly handling the individual values, our data is now contained in a `statistic` model.

We can now easily add a third value to the model: `lastUpdate`. Any component in the chain can use this value to make the program better. But each component doesn't need to fundamentally change: it's still responsible for handling the `statistic` model, just like before.

Models can be complex. A model for a single email message might contain dozens of parameters to handle all the small details about it. And not all of these ever need reach the screen. Often data is concealed, not displayed to the user at all, but used to make the program more reliably perform its role.

Models are an essential contract for your code: they describe what any given component can expect to input and output. Instead of letting individual values leak around your program, think about how a model can organize and describe your program's goals. It's inevitable that models will evolve and change. Understand that those changes can impact many components: data is the job your program does.

## State: truth that changes

A model is the shape of data in your program.

*State* is the concrete value of that data.

In our `statistic` model, the state of `value` might be `41.9`.

But the whole point of the program is that `value` is going to vary over time. Our program's job is to handle those changes by instigating updates and displaying those updates faithfully.

But state management can be hard: it's one of the great sources of bugs across many programs. It's such a challenge, in fact, that entire frameworks and methodologies have been designed to address it. It can be worth discussion and exploration when making state management decisions.

At a high level, here is what you must keep in mind.

**State has to live somewhere**. Where it lives can have consequences. State can be alive in memory, and it might be written somewhere more durable like a file or database.

**State that lives in multiple places is an invitation to disagreement**. When you hear the phrase "single source of truth," you're hearing weary programmers trying their best to narrow the opportunity for such disagreements in their programs.

**Some state is derived from other state**. The individual items in your shopping cart are the ground truth that we derive the *count* of items in your shopping cart from. It's probably a bad idea to store the count separately, as it can fall out of date. Instead, we should calculate it from the truly consequential state: the actual items you've selected.

This idea might be the most important to understand. Modern programs work hard to make what the user sees *a function* of that underlying, ground-truth state. The ideal program turns a metaphorical crank against a set of data and always gets the same output from doing so.

Store truth once, then compute its consequences.
