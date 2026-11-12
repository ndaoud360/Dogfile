# Microsoft Store: dependencies and what to tell certification

Certification rule 10.2 (and the Store policy on "dependencies on non-integrated software") wants every piece of software
Dogfile needs to be either **inside the package**, **part of Windows**, or **named in the listing**. Here is where each one stands.

## Inside the package or part of Windows (nothing to tell anyone)

| Needed by | What | How it is covered |
|---|---|---|
| `Dogfile.exe` | Visual C++ runtime (`VCRUNTIME140.dll`, `VCRUNTIME140_1.dll`, `MSVCP140.dll`) | **Linked into the program** (`.cargo/config.toml`: `crt-static`, `LLAMA_STATIC_CRT`). The first submission failed because it was left as an outside dependency. |
| `Dogfile.exe` | Universal C Runtime, Win32 and COM libraries | Part of Windows 10 / 11. |
| `7zip\7za.exe`, `7z.exe`, `7z.dll` | Only Windows libraries (`kernel32`, `advapi32`, `msvcrt`…) | Part of Windows. |
| Downloaded parts that use Microsoft's C++ compiler (the assistant's engine `llama-server`) | `MSVCP140.dll`, `VCRUNTIME140.dll`, `VCOMP140.dll` | The manifest declares Microsoft's own framework package `Microsoft.VCLibs.140.00.UWPDesktop`; the Store installs it with Dogfile and the programs Dogfile starts find it there. |

`build/ci/check-deps.mjs` reads the imports of every program in the package on each build and fails the build when one needs
something that is not part of Windows or in the package (workflow `app`, steps "What Dogfile.exe needs…" and "Store package contents…";
also by hand: Actions > `deps-check`).

## Named in the listing (do tell them)

1. **Microsoft Edge WebView2 Runtime.** Dogfile draws its windows with it. It comes with Windows 11 and with current Windows 10;
   a Store package cannot carry it.
2. **Parts downloaded the first time they are used, each after a question.** Media engine (FFmpeg), text recognition, the AI
   runtime, the Photoshop helper, cloud-drive support (rclone): from the project's updates repository on GitHub, each address and
   checksum fixed inside the program, and a file that does not match is refused. Also ExifTool (exiftool.org, for editing photo
   details), the assistant's engine (llama.cpp's release on GitHub) and the AI models (Hugging Face). All optional; Dogfile works
   without them.
3. 7-Zip is included in the package (nothing to install).

### Text for the Store description (Partner Center > Store listing > Description, last paragraph)

> Requirements: Windows 10 (version 1809 or later) or Windows 11, with the Microsoft Edge WebView2 Runtime (included with
> Windows 11 and current Windows 10 updates). Some optional features download extra components the first time you use them:
> media playback and conversion (FFmpeg), text recognition in pictures, the built-in AI assistant, Photoshop layers, photo
> details (ExifTool) and extra cloud drives. Dogfile works without them and asks before downloading.

(Each of these shows a "Download…?" question first: `src/renderer/js/components.js`, `ai.js`, `metadata.js`. Re-check that
before keeping the sentence "asks before downloading" if a part is ever added that downloads silently.)

### Notes for certification (Partner Center > Submission options > Notes for certification)

> Dogfile is a file manager (full-trust desktop app, `runFullTrust` and `broadFileSystemAccess` because it browses the user's
> files). It has no sign-in and needs no test account. Dependencies: all Visual C++ runtime code is linked into Dogfile.exe;
> the package also declares Microsoft.VCLibs.140.00.UWPDesktop for helper programs the app downloads on request. The app needs the
> Microsoft Edge WebView2 Evergreen Runtime, which is part of Windows 11 and of current Windows 10, and it uses it to draw its
> windows. Optional components (FFmpeg media engine, OCR data, AI runtime, Photoshop helper, rclone) are downloaded on first use
> from github.com/ndaoud360/dogfile-updates (ExifTool from exiftool.org, AI models from huggingface.co), after the user agrees to
> a question, verified against a checksum built into the app where the app ships one, and stored in the user's app data. Nothing
> is downloaded or installed at first launch.
