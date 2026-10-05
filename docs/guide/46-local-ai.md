# The local AI

cellforge can use a small AI model that runs on your own computer. It helps
in a few places: requests in your own words in the ask bar, explanations of
formulas, category suggestions and spelling variants. Everything else in
cellforge works without it, and every place that uses it also works, in a
plainer way, when it isn't there.

Open the **Private AI** panel from the **Ask AI** button in the toolbar, from the
ask bar (Ctrl+/) with **Set up the local AI…**, or from the command palette
with **AI: set up and manage the local model…**

## What stays private

The model runs in this browser tab, on this computer. Your sheets and what you
type are never sent anywhere, with or without the AI.

The only time cellforge uses the network for AI is when you press a
**Download** button. The button says where the file comes from and how big it
is ("Download 1.1 GB from huggingface.co"), and nothing is downloaded until
you press it. There's no account, no tracking and no usage reporting. Once a
model is downloaded it works offline.

## Getting a model

The AI panel walks you through three steps:

1. **Start without a model.** The ask bar already understands common
   requests, so this one is done from the start.
2. **Get a model.** The panel checks this computer (memory, whether the
   browser can use the graphics card, free storage for this site) and shows
   the model that suits it, marked **Recommended for this computer**. The
   other sizes are one click away.
3. **Load it once.** After that it's kept in the browser and loads by
   itself the first time something needs it.

There are two ways to get a model.

**Download one from the list.** Press **Download** on a model card. The file
goes straight into the browser's private storage for this site, with a
progress bar. You can:

- **Pause** and carry on later, even after closing the tab: **Resume** picks
  up where it stopped instead of starting again.
- **Cancel** to stop and delete what has arrived.

When the download finishes, cellforge checks that the file is exactly the
published one (its size and its SHA-256 fingerprint). A file that doesn't
match is thrown away. Then it loads, and the panel says **Ready**.

**Use a file you already have.** Press **I already have a .gguf file…** and
pick it. cellforge copies it into the browser's private storage, so it's
there next time, and loads it. Models in the GGUF format from the Qwen2,
Llama (2 and 3.0) or Mistral families work, compressed as Q4_K_M, Q4_0 or
Q8_0 (also F16 and F32). Other formats get a plain message saying what isn't
supported.

A model you've downloaded or picked stays in this browser. Next time it loads
by itself the first time something needs it. **Use** switches to another kept
model, **Unload** frees the memory without deleting it, and **Remove** deletes
it from the browser.

## Which model

| | Model | Download | Good for |
| --- | --- | --- | --- |
| Small | Qwen2.5 0.5B Instruct (Q8_0) | 676 MB | Quick, simple requests and spelling variants. Runs on any computer, even without a graphics card. |
| Medium | Qwen2.5 1.5B Instruct (Q4_K_M) | 1.1 GB | The best balance for requests in your own words, explanations and category suggestions. Wants a graphics card and 8 GB of memory. |
| Large | Qwen2.5 3B Instruct (Q4_K_M) | 2.1 GB | The most capable answers. Needs a good graphics card and 16 GB of memory. |

The Small and Medium models are under the Apache 2.0 licence, which allows
use at work. The Large model is under the Qwen Research License, which is for
research and non-commercial use: read it before using that model for client
work. That's one reason the panel never recommends it on its own.

Pick Medium if the panel recommends it. On a computer without a graphics card
the browser can use, pick Small: models then run on the processor, which works
but is several times slower.

## What it does

- **The ask bar** (Ctrl+/) understands common requests by itself. With the
  model loaded, a request it doesn't recognise goes to the model, which can
  only answer with the same actions the ask bar uses. You see what will
  happen before it happens, and every step can be undone. See
  [the ask bar](34-ask-bar.md).
- **Explain this number** can describe a formula in sentences. Every figure
  and cell the model mentions is checked against the formula; if it gets one
  wrong, you get the plain reading instead. See [Explain](35-explain.md).
- **Categorise** can suggest categories for rows no rule covers, choosing
  only from categories you already use. See
  [Checks and categories](33-checks-and-categories.md).
- **Fix spelling variants in this column** can also find abbreviations and
  typos ("Acme Ltd" and "ACME Limited"). See [Cleaning up](15-clean-up.md).

The panel's **What you can do with it** list opens each of these.

## Troubleshooting

**"This browser has no graphics card it can use for AI."** The browser doesn't
offer WebGPU here, so the model runs on the processor. It works, more slowly.
Recent Chrome, Edge and Brave on Windows and macOS have WebGPU; on Linux it may
need turning on in the browser's settings. The Small model suits this case.

**"The graphics card couldn't run it, so it runs on the processor instead."**
The graphics card ran out of memory or stopped responding while the model
loaded. Try a smaller model, or close other tabs that use the graphics card.

**"This computer ran out of memory loading the model."** Close other tabs and
programs, or use a smaller model. A model needs roughly its download size in
free memory, plus some room to work.

**"There isn't enough free storage for this site."** The browser limits how
much each site can keep. Free some disk space, or **Remove** a model you don't
use.

**The download stopped.** A dropped connection keeps what has arrived. Press
**Resume** to carry on.

**"The downloaded file didn't match the published one."** It was thrown away.
Download it again; if it keeps happening, the file on the site has changed.

**"This model file is compressed in a way the built-in AI can't run yet."**
Look for a Q4_K_M, Q4_0 or Q8_0 version of the same model, or use one from the
list.

**A private window.** Some browsers don't let sites keep files in private
windows, so a model can't be downloaded there. Picking a file still works for
that session.

**Clearing the browser's data for this site** deletes kept models along with
autosaved work.
