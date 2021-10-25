import * as ssh2 from "ssh2";
import * as fs from "fs";
import { Writable, Stream, Readable } from "stream";
import { Attributes, FileEntry, SFTPStream } from "ssh2-streams";

import { logger } from "../utils/logger";
import { noHandler } from "./common";
import { join } from 'path';

var openFiles: {
  [id: string]: { stream: Stream; fileHandle: string };
} = {};
var openDirs: { [id: string]: any } = {};

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
  sftpStream.on("STAT", statHandler(sftpStream));
  sftpStream.on("error", (err: any) => {
    logger.info(`Error from sftp is: ${err}`);
  });
};

let currentReadReqId: number;
const openHandler = (sftpStream: SFTPStream) => (
  reqId: number,
  filename: string,
  flags: number
) => {
  logger.info(`in open for ${filename}`);
  // only allow files of format '/<filename>.<ext>' or '/tmp/<filename>.<ext>'
  if (filename.substr(0, 5) === "/tmp/") {
    filename = "tmp/" + filename.substr(5).replace("/", "-");
  } else if (filename.substr(0, 4) === "tmp/") {
    filename = "tmp/" + filename.substr(4).replace("/", "-");
  } else {
    filename = filename.substr(1);
    filename = filename.replace("/", "-");
  }
  // Now set it to the location we want it to write to
  filename = "./sftp-server-files/" + filename;
  // Open mode returns basic stream
  let streamToWrite: Stream;
  logger.info(`Flags: ${flags}`);
  const stringFlags = SFTPStream.flagsToString(flags);
  logger.info(`String flags: ${stringFlags}`);
  if (stringFlags.includes("w")) {
    logger.info("we writing.");
    streamToWrite = fs.createWriteStream(filename, { flags: "w" });
  } else if (stringFlags.includes("a")) {
    logger.info("we be appending.");
    streamToWrite = fs.createWriteStream(filename, { flags: "a" });
  } else if (stringFlags.includes("r")) {
    logger.info("jsut readin for this one.");
    streamToWrite = fs.createReadStream(filename);
    streamToWrite.on("error", (err) => {
      sftpStream.status(
        currentReadReqId,
        ssh2.SFTP_STATUS_CODE.FAILURE,
        err.toString()
      );
    });
  } else {
    return sftpStream.status(reqId, ssh2.SFTP_STATUS_CODE.FAILURE);
  }
  openFiles[filename] = {
    stream: streamToWrite,
    fileHandle: filename,
  };
  sftpStream.handle(reqId, Buffer.from(filename));
  logger.info(`${Date.now().toString()} Opening file for read`);
};

const writeHandler = (sftpStream: SFTPStream) => (
  reqId: number,
  handle: Buffer,
  offset: number,
  data: Buffer
) => {
  let handleString = handle.toString();
  logger.info(
    `in write for reqID: ${reqId}: ${handle.toString()} with data: ${data.toString()}`
  );
  if (!openFiles[handleString]) {
    logger.info("we failed.");
    return sftpStream.status(reqId, ssh2.SFTP_STATUS_CODE.FAILURE);
  }
  // fake the write

  (openFiles[handleString].stream as Writable).write(data, (error) => {
    if (error) {
      logger.info(`Error: ${JSON.stringify(error)}`);
      return sftpStream.status(reqId, ssh2.SFTP_STATUS_CODE.FAILURE);
    }
    logger.info("wrote the file");
    return sftpStream.status(reqId, ssh2.SFTP_STATUS_CODE.OK);
  });
};

const closeHandler = (sftpStream: SFTPStream) => (
  reqId: number,
  handle: Buffer
) => {
  let handleString = handle.toString();
  logger.info(`in close received handle: ${handleString}`);
  if (!openFiles[handleString] && !openDirs[handleString]) {
    logger.info("cannot find path.");
    return sftpStream.status(reqId, ssh2.SFTP_STATUS_CODE.FAILURE);
  }
  if (openFiles[handleString]) {
    logger.info(`Closing file: ${handle}`);
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
  } else {
    openDirs[handleString] = {};
    return sftpStream.status(reqId, ssh2.SFTP_STATUS_CODE.OK);
  }
};
const fstatHandler = (sftpStream: SFTPStream) => (
  reqId: number,
  handle: Buffer
) => {
  logger.info("in fstat");
  logger.info(`Trying to stat: ${handle}`);
  let handleString = handle.toString();
  if (!openFiles[handleString]) {
    logger.info("File not opened to stat.");
    return sftpStream.status(reqId, ssh2.SFTP_STATUS_CODE.FAILURE);
  }
  logger.info(`Stating file: ${handle}`);
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
      logger.info(JSON.stringify(sftpStats));
      sftpStream.attrs(reqId, sftpStats);
    });
  });
};

const statHandler = (sftpStream: SFTPStream) => (
  reqId: number,
  handle: Buffer
) => {
  logger.info("in stat");
  logger.info(`Trying to stat: ${handle}`);
  let handleString = handle.toString();
  const rootDir = join(__dirname, '..', '..', 'sftp-server-files');
  handleString = join(rootDir, handleString);
  fs.stat(handleString, (err, stats) => {
    if (err) {
      logger.debug(`stat error: ${err}`)
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
    logger.info(JSON.stringify(sftpStats));
    sftpStream.attrs(reqId, sftpStats);
  });
};

const readDirHandler = (sftpStream: SFTPStream) => (
  reqId: number,
  handle: Buffer
) => {
  logger.info("in readdir");
  let handleString = handle.toString();
  logger.info(`Trying to readdir: ${handleString}`);
  if (!openDirs[handleString]) {
    logger.info("File not opened to stat.");
    return sftpStream.status(reqId, ssh2.SFTP_STATUS_CODE.FAILURE);
  }
  logger.info(`Stating to read file dir: ${handle}`);
  let fileEntryList: FileEntry[] = [];
  try {
    const files = fs.readdirSync(handleString);
    logger.info(`Files: ${files.join("|")}`);
    for (let file of files) {
      if (openDirs[handleString][file]) {
        continue;
      }
      openDirs[handleString][file] = true;
      const fd = fs.openSync(handleString + "/" + file, "r");
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
    logger.info(`Error getting file states: ${JSON.stringify(err)}`);
    return sftpStream.status(reqId, ssh2.SFTP_STATUS_CODE.FAILURE);
  }
  if (fileEntryList.length > 0) {
    logger.info("Files to return to client.");
    return sftpStream.name(reqId, fileEntryList);
  }

  return sftpStream.status(reqId, ssh2.SFTP_STATUS_CODE.EOF);
};
const renameHandler = (sftpStream: SFTPStream) => (
  reqId: number,
  oldPath: string,
  newPath: string
) => {
  logger.info(`${Date.now().toString()} Renaming`);
  if (oldPath.substr(0, 5) === "/tmp/") {
    oldPath = "tmp/" + oldPath.substr(5).replace("/", "-");
  } else {
    oldPath = oldPath.substr(1);
    oldPath = oldPath.replace("/", "-");
  }
  // Now set it to the location we want it to write to
  oldPath = "./sftp-server-files/" + oldPath;

  if (newPath.substr(0, 5) === "/tmp/") {
    newPath = "tmp/" + newPath.substr(5).replace("/", "-");
  } else {
    newPath = newPath.substr(1);
    newPath = newPath.replace("/", "-");
  }
  // Now set it to the location we want it to write to
  newPath = "./sftp-server-files/" + newPath;

  try {
    fs.renameSync(oldPath, newPath);
    sftpStream.status(reqId, ssh2.SFTP_STATUS_CODE.OK);
  } catch (err: any) {
    sftpStream.status(reqId, ssh2.SFTP_STATUS_CODE.FAILURE, err.message);
  }
};
const removeHandler = (sftpStream: SFTPStream) => (
  reqId: number,
  path: string
) => {
  if (path.substr(0, 5) === "/tmp/") {
    path = "tmp/" + path.substr(5).replace("/", "-");
  } else {
    path = path.substr(1);
    path = path.replace("/", "-");
  }
  // Now set it to the location we want it to write to
  path = "./sftp-server-files/" + path;
  logger.info(`Trying to delete path: ${path}`);
  try {
    fs.unlinkSync(path);
    return sftpStream.status(reqId, ssh2.SFTP_STATUS_CODE.OK);
  } catch (err) {
    logger.info(`Error occured: ${err}`);
    return sftpStream.status(reqId, ssh2.SFTP_STATUS_CODE.FAILURE);
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
    `in read for reqID: ${reqId}: ${handle.toString()} with data length: ${length}`
  );
  if (!openFiles[handleString]) {
    logger.info("we failed.");
    return sftpStream.status(reqId, ssh2.SFTP_STATUS_CODE.FAILURE);
  }
  // Just read the heck from it
  currentReadReqId = reqId;
  const dataRead = (openFiles[handleString].stream as Readable).read(length);
  if (!dataRead || dataRead.length === 0 || dataRead[0] === null) {
    // let handlers send the response.
    return sftpStream.status(reqId, ssh2.SFTP_STATUS_CODE.EOF);
  }
  return sftpStream.data(reqId, dataRead);
};
const openDirHandler = (sftpStream: SFTPStream) => (
  reqId: number,
  path: string
) => {
  logger.info("in opendir.");
  // only allow files of format '/<filename>.<ext>' or '/tmp/<filename>.<ext>'
  if (path[0] !== "/") {
    path = "/" + path;
  }
  // Now set it to the location we want it to write to
  path = "./sftp-server-files" + path;
  logger.info(`Opened path: ${path}`);
  openDirs[path] = {};
  sftpStream.handle(reqId, Buffer.from(path));
};

const realPathHandler = (sftpStream: SFTPStream) => (
  reqId: number,
  path: string
) => {
  logger.info(`in realpath: ${reqId} for ${path}`);
  try {
    if (path[0] !== "/") {
      path = "/" + path;
    }
    const realPathResult = fs.realpathSync("sftp-server-files" + path);
    logger.info(`Real path: ${realPathResult}`);
    if (!realPathResult.includes("sftp-server-files")) {
      throw new Error("Not a valid path on this server.");
    } else {
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
      logger.info(`Stats for file path: ${JSON.stringify(sftpStats)}`);
      const pathIndex = realPathResult.indexOf("sftp-server-files");
      let subFilePath: string;
      if (pathIndex + 17 >= realPathResult.length) {
        subFilePath = "/";
      } else {
        subFilePath = realPathResult.slice(pathIndex + 17);
      }

      logger.info(`Final path: ${subFilePath}`);
      sftpStream.name(reqId, [
        {
          filename: subFilePath,
          longname: subFilePath + "/",
          attrs: sftpStats,
        },
      ]);
    }
  } catch (err: any) {
    logger.info(`Real path error: ${JSON.stringify(err)}`);
    sftpStream.status(reqId, ssh2.SFTP_STATUS_CODE.FAILURE, err.message);
  }
};
