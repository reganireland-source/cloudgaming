# The Rocjob page: how to change it

The page lives at **/rocjob** on the GGGH site. Everything on it comes from
one file in this folder: **`page.txt`**. You never need to touch `index.html`.

## Change any text, the version or the download link

1. Open **`page.txt`** in this folder on GitHub.
2. Click the **pencil icon** (Edit this file).
3. Change the text. For example:
   - **New build:** change the `Version:` line (say, `Version: Build 17`) and the `Release notes:` line.
   - **New Drive link:** replace everything after `Download link:` with the new link.
     Swapping files inside the same Drive folder needs no change at all.
   - **Contact line:** write an email address or a web link after `Contact:`.
     Leave it empty to hide the line.
4. Click **Commit changes** (twice: once in the corner, once in the box that pops up).

The page updates about a minute later, once the site has redeployed.

## Add a screenshot

1. Open the **`screenshots`** folder, click **Add file → Upload files**, drop the
   picture in (JPG, about 1600 px wide is ideal) and click **Commit changes**.
2. Open **`page.txt`** and add a line under `[Screenshots]`:

   ```
   - my-new-picture.jpg | What the caption should say
   ```

   Pictures show in the order of these lines. Move a line to move the picture.

To remove a screenshot, delete its line in `page.txt`.

If a file name doesn't match exactly (capital letters count), the page shows
"Missing picture" in its place, so you can spot the typo.

## Rules of `page.txt`

- Lines starting with `#` are notes. The page ignores them.
- `Name: value` lines at the top are single settings.
- `[Name]` starts a section, and a `- ` line is one item in a list.
- In the stage and screenshot lists, `|` splits a line in two: song | band,
  or file | caption.
- Under `[Stages]`, a line ending in a colon (like `Act 2:`) starts a new act.
  Stages are numbered for you.

If something looks wrong after an edit, the old version is one click away:
on GitHub open `page.txt` → **History**, and copy back what was there.
