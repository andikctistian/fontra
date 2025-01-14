import argparse
import logging
import pathlib
from importlib import resources
from importlib.metadata import entry_points

from aiohttp import web

from ..core.fonthandler import FontHandler

logger = logging.getLogger(__name__)


fileExtensions = {
    f".{ep.name}" for ep in entry_points(group="fontra.filesystem.backends")
}


class FileSystemProjectManagerFactory:
    @staticmethod
    def addArguments(parser):
        parser.add_argument(
            "path",
            type=existingFolderOrFontFile,
            help="A path to an folder containing font files, or a path to a "
            "single font file. Alternatively you can pass the special value "
            "'-' to bypass the landing page, and use a full OS FS path as part "
            "of the view URL.",
        )
        parser.add_argument("--max-folder-depth", type=int, default=3)
        parser.add_argument("--read-only", action="store_true")

    @staticmethod
    def getProjectManager(arguments):
        return FileSystemProjectManager(
            rootPath=arguments.path,
            maxFolderDepth=arguments.max_folder_depth,
            readOnly=arguments.read_only,
        )


def existingFolderOrFontFile(path):
    if path == "-":
        return None
    path = pathlib.Path(path).resolve()
    ext = path.suffix.lower()
    if ext not in fileExtensions and not path.is_dir():
        raise argparse.ArgumentError("invalid path")
    return path


def getFileSystemBackend(path):
    path = pathlib.Path(path)
    if not path.exists():
        raise FileNotFoundError(path)
    logger.info(f"loading project {path.name}...")
    fileType = path.suffix.lstrip(".").lower()
    backendEntryPoints = entry_points(group="fontra.filesystem.backends")
    entryPoint = backendEntryPoints[fileType]
    backendClass = entryPoint.load()

    backend = backendClass.fromPath(path)
    logger.info(f"done loading {path.name}")
    return backend


class FileSystemProjectManager:
    def __init__(self, rootPath, maxFolderDepth=3, readOnly=False):
        self.rootPath = rootPath
        self.singleFilePath = None
        self.maxFolderDepth = maxFolderDepth
        self.readOnly = readOnly
        if self.rootPath is not None and self.rootPath.suffix.lower() in fileExtensions:
            self.singleFilePath = self.rootPath
            self.rootPath = self.rootPath.parent
        self.fontHandlers = {}

    async def close(self):
        for fontHandler in self.fontHandlers.values():
            await fontHandler.close()

    async def authorize(self, request):
        return "yes"  # arbitrary non-false string token

    async def projectPageHandler(self, request, filterContent=None):
        html = resources.read_text("fontra.filesystem", "landing.html")
        if filterContent is not None:
            html = filterContent(html, "text/html")
        return web.Response(text=html, content_type="text/html")

    async def projectAvailable(self, path, token):
        return bool(self._getProjectPath(path))

    async def getRemoteSubject(self, path, token):
        assert path[0] == "/"
        path = path[1:]
        fontHandler = self.fontHandlers.get(path)
        if fontHandler is None:
            projectPath = self._getProjectPath(path)
            if projectPath is None:
                raise FileNotFoundError(projectPath)
            backend = getFileSystemBackend(projectPath)
            fontHandler = FontHandler(backend, readOnly=self.readOnly)
            await fontHandler.startTasks()
            self.fontHandlers[path] = fontHandler
        return fontHandler

    def _getProjectPath(self, path):
        if self.rootPath is None:
            projectPath = pathlib.Path(path)
            if not projectPath.is_absolute():
                projectPath = "/" / projectPath
        else:
            projectPath = self.rootPath.joinpath(*path.split("/"))

        if projectPath.suffix.lower() in fileExtensions and projectPath.exists():
            return projectPath
        return None

    async def getProjectList(self, token):
        if self.rootPath is None:
            return []
        projectPaths = []
        rootItems = self.rootPath.parts
        if self.singleFilePath is not None:
            paths = [self.singleFilePath]
        else:
            paths = sorted(
                _iterFolder(self.rootPath, fileExtensions, self.maxFolderDepth)
            )
        for projectPath in paths:
            projectItems = projectPath.parts
            assert projectItems[: len(rootItems)] == rootItems
            projectPaths.append("/".join(projectItems[len(rootItems) :]))
        return projectPaths


def _iterFolder(folderPath, extensions, maxDepth=3):
    if maxDepth is not None and maxDepth <= 0:
        return
    for childPath in folderPath.iterdir():
        if childPath.suffix.lower() in extensions:
            yield childPath
        elif childPath.is_dir():
            yield from _iterFolder(
                childPath, extensions, maxDepth - 1 if maxDepth is not None else None
            )
