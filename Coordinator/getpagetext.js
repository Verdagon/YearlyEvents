
import util from 'node:util';
import { execFile, spawn } from 'node:child_process'
import fs from "fs/promises";
import { logs, VException } from "../Common/utils.js";

const execFileAsync = util.promisify(execFile);

async function runCommandForStatus(program, args) {
  try {
    // Seems to return an object with just two fields, like:
    // { stdout: 'Success!\n', stderr: '' }
    await execFileAsync(program, args);
    return 0;
  } catch (e) {
    if (e.exitCode !== undefined || e.stdout !== undefined || e.stderr !== undefined) {
      console.log("Command failed: ", program, args);
      console.log("exitCode:\n" + e.exitCode);
      console.log("stdout:\n" + e.stdout);
      console.log("stderr:\n" + e.stderr);
      return e.exitCode;
    } else {
      console.log("Command failed: ", program, args, "Error:", e);
      throw e;
    }
  }
}

async function getPageTextInner(scratchDir, db, chromeFetcher, chromeCacheCounter, throttlerPriority, maybeIdForLogging, steps, eventI, resultI, url) {
  const htmlOutputPath = scratchDir + "/result" + eventI + "-" + resultI + ".html"
  console.log("Asking for html for " + url + " to " + htmlOutputPath);
  try {
    console.log("Fetch expensive", maybeIdForLogging, "chromeFetcher:", url);
    // debugger;
    await chromeFetcher.send(url.trim() + " " + htmlOutputPath.trim());
  } catch (err) {
    const error =
        "Bad fetch/browse for url " + url + ": " + 
        (err.status ?
            err.status + ": " + err.rest :
            err);
    console.log(error);
    return {text: null, error};
  }

  const txt_path = scratchDir + "/" + url.replaceAll("/", "").replace(/\W+/ig, "-") + ".txt"
  const commandArgs = ["./PdfToText/main.py", htmlOutputPath, txt_path];
  const extractorExitCode = await runCommandForStatus("python3", commandArgs)
  console.log("Ran text extractor, exit code:", extractorExitCode)
  if (extractorExitCode !== 0) {
    const error = "Bad text extractor for url " + url + " html path " + htmlOutputPath;
    console.log(error);
    return {text: null, error};
  }
  steps.push(["Created text in", txt_path])
  const text = (await fs.readFile(txt_path, { encoding: 'utf8' })).trim();
  if (!text) {
    const error = "No result text found for url " + url + ", args: " + commandArgs.join(" ");
    console.log(error);
    return {text: null, error};
  }

  return {text, error: null};
}

export async function getPageText(scratchDir, db, chromeFetcher, chromeCacheCounter, throttlerPriority, retryErrors, maybeIdForLogging, steps, eventI, resultI, url) {
  // This used to be wrapped in a transaction but I think it was causing the connection
  // pool to get exhausted.

  const cachedPageTextRow = await db.getPageText(url);
  if (cachedPageTextRow) {
    if (!cachedPageTextRow.text && retryErrors) {
      // Retry it
    } else {
      chromeCacheCounter.count++;
      return cachedPageTextRow;
    }
  }

  const {text, error} =
      await getPageTextInner(
          scratchDir, db, chromeFetcher, chromeCacheCounter, throttlerPriority, maybeIdForLogging, steps, eventI, resultI, url);
  // This automatically merges on conflict
  await db.cachePageText({url, text, error});
  return {text, error};
}
