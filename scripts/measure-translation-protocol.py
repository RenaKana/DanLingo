"""Offline tokenizer worker. Reads explicit synthetic strings from stdin; never downloads tokenizer data."""
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile


def main():
    request = json.load(sys.stdin)
    config = request["tokenizer"]
    if config.get("path"):
        from tokenizers import Tokenizer
        import tokenizers
        model_path = Path(config["path"])
        tokenizer = Tokenizer.from_file(str(model_path))
        count = lambda text: len(tokenizer.encode(text, add_special_tokens=False).ids)
        identity = {"library": "tokenizers", "version": tokenizers.__version__,
                    "name": config.get("name", model_path.name), "sha256": hashlib.sha256(model_path.read_bytes()).hexdigest()}
    else:
        import tiktoken
        import tiktoken.load

        def offline_read(blobpath, expected_hash=None):
            cache_dir = os.environ.get("TIKTOKEN_CACHE_DIR", os.environ.get("DATA_GYM_CACHE_DIR", os.path.join(tempfile.gettempdir(), "data-gym-cache")))
            cache_path = Path(cache_dir) / hashlib.sha1(blobpath.encode()).hexdigest()
            if not cache_dir or not cache_path.is_file():
                raise RuntimeError("offline tokenizer cache unavailable; no network download attempted")
            data = cache_path.read_bytes()
            if expected_hash and hashlib.sha256(data).hexdigest() != expected_hash:
                raise RuntimeError("offline tokenizer cache hash mismatch; no deletion or download attempted")
            return data

        tiktoken.load.read_file_cached = offline_read
        tokenizer = tiktoken.get_encoding(config.get("encoding", "cl100k_base"))
        count = lambda text: len(tokenizer.encode(text, disallowed_special=()))
        identity = {"library": "tiktoken", "version": tiktoken.__version__, "name": tokenizer.name}

    result = []
    for record in request["records"]:
        content = record["content"]
        fixed = sum(count(text) for text in content["system"])
        user = count(content["user"])
        sources = sum(count(text) for text in content["sources"])
        output = count(content["output"]) if content["output"] is not None else None
        output_texts = sum(count(text) for text in content["outputTexts"])
        result.append({"id": record["id"], "fixedPromptTokens": fixed, "userContentTokens": user,
                       "sourceTokensInIsolation": sources, "inputFramingResidual": user - sources,
                       "promptContentTokens": fixed + user, "outputContentTokens": output,
                       "outputTextTokensInIsolation": output_texts,
                       "outputFramingResidual": output - output_texts if output is not None else None})
    print(json.dumps({"tokenizer": identity, "records": result}, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"available": False, "error": str(error)}, ensure_ascii=False))
        sys.exit(1)
