#!/usr/bin/env python3
"""Restrict this one-off release rehearsal to the named fork and namespace."""

import argparse
import os
from pathlib import Path
import re
import sys


REPOSITORY = "robert-cronin/airunway"
IMAGE_PREFIX = "ghcr.io/robert-cronin/airunway-rehearsal-v080-20260910"
VERSION = "0.8.0"
FAMILIES = frozenset(
    (
        "dashboard", "controller", "model-downloader",
        "agent-crewai", "agent-langgraph", "agent-openclaw", "agent-hermes",
        "agent-container-provider", "agent-kagent-provider", "agent-orka-provider",
        "dynamo-provider", "kaito-provider", "kuberay-provider", "llmd-provider",
        "vllm-provider",
    )
)


def validate_context(expected_event):
    if os.environ.get("GITHUB_REPOSITORY") != REPOSITORY:
        raise ValueError("repository must be the rehearsal fork")
    if os.environ.get("GITHUB_REF") != f"refs/tags/v{VERSION}":
        raise ValueError("publication requires the fork's v0.8.0 tag")
    if os.environ.get("GITHUB_EVENT_NAME") != expected_event:
        raise ValueError("unexpected publication event")
    if expected_event == "workflow_dispatch":
        if os.environ.get("REHEARSAL_VERSION") != VERSION:
            raise ValueError("provider dispatch version must be 0.8.0")


def validated_tags():
    family = os.environ.get("REHEARSAL_IMAGE_FAMILY", "")
    if family not in FAMILIES:
        raise ValueError("unexpected image family")
    image = f"{IMAGE_PREFIX}/{family}"
    tags = os.environ.get("REHEARSAL_TAGS", "").splitlines()
    pattern = re.compile(re.escape(image) + r":[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}")
    if not tags or any(not pattern.fullmatch(tag) for tag in tags):
        raise ValueError("every tag must name the exact fork image with a valid Docker tag")
    if f"{image}:{VERSION}" not in tags:
        raise ValueError("missing the required 0.8.0 image tag")
    return tags


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("context", "tags"))
    parser.add_argument("event", choices=("push", "workflow_dispatch"))
    args = parser.parse_args()
    try:
        validate_context(args.event)
        if args.mode == "tags":
            tags = validated_tags()
            output = os.environ.get("GITHUB_OUTPUT")
            if not output:
                raise ValueError("GITHUB_OUTPUT is required")
            # Validate the entire list before exposing anything to the publisher.
            # The delimiter cannot occur in a validated, fully qualified image tag.
            payload = "tags<<FORK_REHEARSAL_TAGS\n" + "\n".join(tags)
            with Path(output).open("a", encoding="utf-8") as stream:
                stream.write(payload + "\nFORK_REHEARSAL_TAGS\n")
    except (OSError, ValueError) as error:
        print(f"Fork publication blocked: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
