import * as ssh2 from "ssh2";
import * as fs from "fs";
import * as path from "path";
import * as uuid from "uuid";
import { Writable, Stream, Readable } from "stream";
import { Attributes, FileEntry, SFTPStream } from "ssh2-streams";

import { logger } from "../utils/logger";
import { noHandler } from "./common";
import { rootDir } from "../config";

// FUTURE: Make these classes that support multiple ops on the same file in queue order
const openFiles: {
  [id: string]: {
    stream: Stream;
    fileHandle: string;
    clientHandle: string;
    isDir: boolean;
  };
} = {};

export const addSftpStreamHandlers = (sftpStream: SFTPStream) => {
  sftpStream.on("OPEN", openHandler(sftpStream));
  sftpStream.on("WRITE", writeHandler(sftpStream));
  sftpStream.on("CLOSE", closeHandler(sftpStream));
  sftpStream.on("FSTAT", fstatHandler(sftpStream));
  sftpStream.on("READDIR", readDirHandler(sftpStream));
  sftpStream.on("RENAME", renameHandler(sftpStream));
  sftpStream.on("REMOVE", removeHandler(sftpStream));
  sftpStream.on("READ", readHandler(sftpStream));
  sftpStream.on("OPENDIR", openDirHandler(sftpStream));
  sftpStream.on("REALPATH", realPathHandler(sftpStream));
  sftpStream.on("READLINK", noHandler("SFTPStream:readlink"));
  sftpStream.on("LSTAT", noHandler("SFTPStream:lstat"));
  sftpStream.on("error", (err: any) => {
    logger.info(`Error from sftp is: ${err}`);
  });
};

const openHandler = (sftpStream: SFTPStream) => (
  reqId: number,
  filename: string,
  flags: number
) => {
  logger.info(`in open for ${filename}`);

  // Add whatever path received to our "root" dir
  const finalPathName = path.join(rootDir, filename);

  if (!fs.existsSync(finalPathName)) {
    return sftpStream.status(
      reqId,
      ssh2.SFTP_STATUS_CODE.NO_SUCH_FILE,
      // Prefix with the root path if necessary so they know we only support "root" access
      `File does not exist ${filename[0] === "/" ? filename : "/" + filename}`
    );
  }

  // Determine mode this file is opened in and create the appropriate stream
  let streamToWrite: Stream;
  const stringFlags = SFTPStream.flagsToString(flags);
  if (stringFlags.includes("w")) {
    logger.debug("File opened in 'write' mode.");
    streamToWrite = fs.createWriteStream(finalPathName, { flags: "w" });
  } else if (stringFlags.includes("a")) {
    logger.debug("File opened in 'append' mode.");
    streamToWrite = fs.createWriteStream(finalPathName, { flags: "a" });
  } else if (stringFlags.includes("r")) {
    logger.debug("File opened in 'read' mode.");
    streamToWrite = fs.createReadStream(finalPathName);
  } else {
    return sftpStream.status(
      reqId,
      ssh2.SFTP_STATUS_CODE.OP_UNSUPPORTED,
      "Only read, write, and append mode are supported."
    );
  }

  // This could probably be encapsulated in the open files class as well potentially
  streamToWrite.on("error", (err) => {
    logger.error(`Stream error for mode: ${stringFlags}.`, finalPathName);
    sftpStream.status(reqId, ssh2.SFTP_STATUS_CODE.FAILURE, err.toString());
  });

  // Tie it all together with an opaque UUID for consistent length
  const fileOpId = uuid.v4();
  openFiles[fileOpId] = {
    isDir: false,
    stream: streamToWrite,
    fileHandle: finalPathName,
    clientHandle: filename,
  };
  sftpStream.handle(reqId, Buffer.from(fileOpId));
};

const writeHandler = (sftpStream: SFTPStream) => (
  reqId: number,
  handle: Buffer,
  // FUTURE: support offset with the data buffer, so this can be done right
  offset: number,
  data: Buffer
) => {
  let handleString = handle.toString();
  logger.info(
    `In write for reqID: ${reqId}: ${handleString} with data length: ${data.length}`
  );
  if (!openFiles[handleString]) {
    logger.error("Requested to write file that has never been opened.");
    return sftpStream.status(
      reqId,
      ssh2.SFTP_STATUS_CODE.FAILURE,
      "File must first be opened before writing."
    );
  }

  if (openFiles[handleString].isDir) {
    logger.error("Requested to write to directory instead of file");
    return sftpStream.status(
      reqId,
      ssh2.SFTP_STATUS_CODE.FAILURE,
      "Cannot write to directory, try a file."
    );
  }

  // Do the write
  (openFiles[handleString].stream as Writable).write(data, (error) => {
    if (error) {
      logger.error(`Error: ${JSON.stringify(error)}`);
      return sftpStream.status(reqId, ssh2.SFTP_STATUS_CODE.FAILURE);
    }
    logger.debug("Successfully wrote the file");
    return sftpStream.status(reqId, ssh2.SFTP_STATUS_CODE.OK);
  });
};

const closeHandler = (sftpStream: SFTPStream) => (
  reqId: number,
  handle: Buffer
) => {
  let handleString = handle.toString();
  logger.info(`In close received handle: ${handleString}`);
  if (!openFiles[handleString]) {
    logger.warn(
      "Cannot find path, but saying we 'closed' it, since it's not open"
    );
    return sftpStream.status(reqId, ssh2.SFTP_STATUS_CODE.OK);
  }
  logger.info(`Closing file: ${openFiles[handleString].fileHandle}`);
  if (openFiles[handleString].stream instanceof Readable) {
    (openFiles[handleString].stream as Readable).destroy();
    delete openFiles[handleString];
    return sftpStream.status(reqId, ssh2.SFTP_STATUS_CODE.OK);
  } else {
    (openFiles[handleString].stream as Writable).end(null, () => {
      (openFiles[handleString].stream as Writable).destroy();
      delete openFiles[handleString];
      return sftpStream.status(reqId, ssh2.SFTP_STATUS_CODE.OK);
    });
  }
};
const fstatHandler = (sftpStream: SFTPStream) => (
  reqId: number,
  handle: Buffer
) => {
  logger.info(`Trying to fstat: ${handle}`);
  let handleString = handle.toString();
  if (!openFiles[handleString]) {
    logger.error("File not opened to stat.");
    return sftpStream.status(
      reqId,
      ssh2.SFTP_STATUS_CODE.FAILURE,
      "File not opened to stat."
    );
  }
  fs.open(openFiles[handleString].fileHandle, "r", (err, fd) => {
    if (err) {
      return sftpStream.status(reqId, ssh2.SFTP_STATUS_CODE.FAILURE);
    }
    fs.fstat(fd, (err, stats) => {
      if (err) {
        return sftpStream.status(reqId, ssh2.SFTP_STATUS_CODE.FAILURE);
      }
      const sftpStats: Attributes = {
        mode: stats.mode,
        uid: stats.uid,
        gid: stats.gid,
        size: stats.size,
        atime: stats.atime.valueOf(),
        mtime: stats.mtime.valueOf(),
      };
      logger.debug("Stats: ", JSON.stringify(sftpStats));
      sftpStream.attrs(reqId, sftpStats);
    });
  });
};
const readDirHandler = (sftpStream: SFTPStream) => (
  reqId: number,
  handle: Buffer
) => {
  let handleString = handle.toString();
  logger.info(`Trying to readdir: ${handleString}`);
  // Should check that this is a dir, it'll error below if not.
  if (!openFiles[handleString]) {
    logger.info("File not opened to stat.");
    return sftpStream.status(reqId, ssh2.SFTP_STATUS_CODE.FAILURE);
  }
  const finalPathName = openFiles[handleString].fileHandle;
  logger.info(`Stating to read file dir: ${finalPathName}`);
  let fileEntryList: FileEntry[] = [];
  try {
    const files = fs.readdirSync(finalPathName);
    logger.debug(`Files: ${files.join("|")}`);
    for (let file of files) {
      if (openFiles[handleString][file]) {
        continue;
      }
      openFiles[handleString][file] = true;
      const fd = fs.openSync(path.join(finalPathName, file), "r");
      const fileAttributes = fs.fstatSync(fd);
      const sftpStats: Attributes = {
        mode: fileAttributes.mode,
        uid: fileAttributes.uid,
        gid: fileAttributes.gid,
        size: fileAttributes.size,
        atime: fileAttributes.atime.valueOf(),
        mtime: fileAttributes.mtime.valueOf(),
      };
      let longname: string;
      if (file === "tmp") {
        longname = "drwxrwxrwx";
      } else {
        longname = "-rwxrwxrwx";
      }
      longname = longname + "  1 user group    11 Sep 27 12:00 " + file;
      fileEntryList.push({
        filename: file,
        longname: longname,
        attrs: sftpStats,
      });
    }
  } catch (err) {
    logger.error(`Error getting file stats: ${JSON.stringify(err)}`);
    return sftpStream.status(reqId, ssh2.SFTP_STATUS_CODE.FAILURE);
  }
  if (fileEntryList.length > 0) {
    logger.info(`Found ${fileEntryList.length} files to return to client.`);
    return sftpStream.name(reqId, fileEntryList);
  }

  logger.info("No file entries for stat");
  return sftpStream.status(reqId, ssh2.SFTP_STATUS_CODE.EOF);
};
const renameHandler = (sftpStream: SFTPStream) => (
  reqId: number,
  oldPath: string,
  newPath: string
) => {
  logger.info(`Renaming path. Old: [${oldPath}]. New: [${newPath}]`);
  // Add whatever path received to our "root" dir
  const finalOldPath = path.join(rootDir, oldPath);
  const finalNewPath = path.join(rootDir, newPath);
  if (!fs.existsSync(finalOldPath)) {
    return sftpStream.status(
      reqId,
      ssh2.SFTP_STATUS_CODE.NO_SUCH_FILE,
      // Prefix with the root path if necessary so they know we only support "root" access
      `Path does not exist ${oldPath[0] === "/" ? oldPath : "/" + oldPath}`
    );
  }

  try {
    fs.renameSync(finalOldPath, finalNewPath);
    logger.debug("Rename success!");
    sftpStream.status(reqId, ssh2.SFTP_STATUS_CODE.OK);
  } catch (err) {
    logger.error(
      `Failed to rename path: ${finalOldPath} -> ${finalNewPath}`,
      err
    );
    sftpStream.status(reqId, ssh2.SFTP_STATUS_CODE.FAILURE, err.message);
  }
};

/**
 *
 * @param sftpStream
 * FUTURE: This should only allow certain users delete options likely
 */
const removeHandler = (sftpStream: SFTPStream) => (
  reqId: number,
  requestedPath: string
) => {
  logger.info(`Removing path: [${requestedPath}]`);
  // Add whatever path received to our "root" dir
  const finalPathName = path.join(rootDir, requestedPath);

  if (!fs.existsSync(finalPathName)) {
    return sftpStream.status(
      reqId,
      ssh2.SFTP_STATUS_CODE.NO_SUCH_FILE,
      // Prefix with the root path if necessary so they know we only support "root" access
      `Path does not exist ${
        requestedPath[0] === "/" ? requestedPath : "/" + requestedPath
      }`
    );
  }
  logger.info(`Trying to delete path: ${finalPathName}`);
  try {
    fs.unlinkSync(finalPathName);
    return sftpStream.status(reqId, ssh2.SFTP_STATUS_CODE.OK);
  } catch (err) {
    logger.info(`Error occurred: ${err}`);
    return sftpStream.status(reqId, ssh2.SFTP_STATUS_CODE.FAILURE, err);
  }
};
const readHandler = (sftpStream: SFTPStream) => (
  reqId: number,
  handle: Buffer,
  offset: number,
  length: number
) => {
  let handleString = handle.toString();
  logger.info(
    `In read for reqID: ${reqId}: ${handle.toString()} with data length: ${length}`
  );
  if (!openFiles[handleString]) {
    logger.error(`No file was opened for ID: ${handle}`);
    return sftpStream.status(
      reqId,
      ssh2.SFTP_STATUS_CODE.FAILURE,
      "No file open."
    );
  }
  // Just read the heck from it
  const dataRead = (openFiles[handleString].stream as Readable).read(length);
  if (!dataRead || dataRead.length === 0 || dataRead[0] === null) {
    // let handlers send the response.
    return sftpStream.status(reqId, ssh2.SFTP_STATUS_CODE.EOF);
  }
  return sftpStream.data(reqId, dataRead);
};
const openDirHandler = (sftpStream: SFTPStream) => (
  reqId: number,
  requestedPath: string
) => {
  logger.info(`Opening directory: [${requestedPath}]`);
  // Add whatever path received to our "root" dir
  const finalPathName = path.join(rootDir, requestedPath);

  // FUTURE: Make sure it's a directory here and don't assume
  if (!fs.existsSync(finalPathName)) {
    return sftpStream.status(
      reqId,
      ssh2.SFTP_STATUS_CODE.NO_SUCH_FILE,
      // Prefix with the root path if necessary so they know we only support "root" access
      `Dir does not exist ${
        requestedPath[0] === "/" ? requestedPath : "/" + requestedPath
      }`
    );
  }

  // Tie it all together with an opaque UUID for consistent length
  const fileOpId = uuid.v4();
  openFiles[fileOpId] = {
    isDir: true,
    stream: {} as Stream,
    fileHandle: finalPathName,
    clientHandle: requestedPath,
  };
  sftpStream.handle(reqId, Buffer.from(fileOpId));
};

const realPathHandler = (sftpStream: SFTPStream) => (
  reqId: number,
  requestedPath: string
) => {
  logger.info(`In realpath: ${reqId} for ${requestedPath}`);
  try {
    const realPathResult = path.join(rootDir, requestedPath);
    if (!fs.existsSync(realPathResult)) {
      throw new Error("Not a valid path on this server.");
    }

    const fd = fs.openSync(realPathResult, "r");
    const fileAttributes = fs.fstatSync(fd);
    const sftpStats: Attributes = {
      mode: fileAttributes.mode,
      uid: fileAttributes.uid,
      gid: fileAttributes.gid,
      size: fileAttributes.size,
      atime: fileAttributes.atime.valueOf(),
      mtime: fileAttributes.mtime.valueOf(),
    };
    logger.debug(`Stats for file path: ${JSON.stringify(sftpStats)}`);
    let subFilePath =
      requestedPath[0] === "/" ? requestedPath : "/" + requestedPath;
    sftpStream.name(reqId, [
      {
        filename: subFilePath,
        longname: subFilePath + "/",
        attrs: sftpStats,
      },
    ]);
  } catch (err) {
    logger.error(`Real path error: ${JSON.stringify(err)}`);
    sftpStream.status(reqId, ssh2.SFTP_STATUS_CODE.FAILURE, err.message);
  }
};
