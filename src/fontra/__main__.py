import argparse
import logging
import pathlib
import sys
from .core.server import FontraServer


def existingFolder(path):
    path = pathlib.Path(path).resolve()
    if not path.is_dir():
        raise argparse.ArgumentError("not a directory")
    return path


def main():
    logging.basicConfig(
        format="%(asctime)s %(name)-17s %(levelname)-8s %(message)s",
        level=logging.INFO,
        datefmt="%Y-%m-%d %H:%M:%S",
    )
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="localhost")
    parser.add_argument("--http-port", default=8000, type=int)
    parser.add_argument("--websocket-port", type=int)
    parser.add_argument("--websocket-proxy-port", type=int)
    parser.add_argument("--rcjk-host")
    parser.add_argument("--filesystem-root", type=existingFolder)
    parser.add_argument(
        "--force-login",
        action="store_true",
        help="Enforce login, even for a project manager that doesn't need it. "
        "For testing login.",
    )
    args = parser.parse_args()

    host = args.host
    httpPort = args.http_port
    webSocketPort = (
        args.websocket_port if args.websocket_port is not None else httpPort + 1
    )
    webSocketProxyPort = (
        args.websocket_proxy_port
        if args.websocket_proxy_port is not None
        else webSocketPort
    )

    if (args.rcjk_host and args.filesystem_root) or (
        not args.rcjk_host and not args.filesystem_root
    ):
        print("You must specify exactly one of --rcjk-host and --filesystem-root.")
        sys.exit(1)

    if args.filesystem_root:
        from .core.projectmanager_fs import FileSystemProjectManager

        manager = FileSystemProjectManager(args.filesystem_root)
    else:
        from .core.projectmanager_rcjk import RCJKProjectManager

        manager = RCJKProjectManager(args.rcjk_host)

    if args.force_login:
        manager.requireLogin = True

    server = FontraServer(
        host=host,
        httpPort=httpPort,
        webSocketPort=webSocketPort,
        webSocketProxyPort=webSocketProxyPort,
        projectManager=manager,
    )
    server.setup()
    server.run()


if __name__ == "__main__":
    main()