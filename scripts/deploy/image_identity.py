"""Portable content identity across classic and containerd Docker image stores."""
import hashlib
import json
import sys


def image_identity(image):
    config = image.get('Config')
    layers = image.get('RootFS', {}).get('Layers')
    if not isinstance(config, dict) or not isinstance(layers, list) or not layers:
        raise ValueError('Image is missing its runnable configuration or filesystem layers')
    identity = {key: image.get(key) or '' for key in ('Os', 'Architecture', 'Variant')}
    identity['layers'] = layers
    identity['config'] = {}
    for key in ('Env', 'Cmd', 'Entrypoint', 'Shell'):
        identity['config'][key] = config.get(key) or []
    for key in ('WorkingDir', 'User', 'StopSignal'):
        identity['config'][key] = config.get(key) or ''
    for key in ('Labels', 'ExposedPorts', 'Volumes', 'Healthcheck'):
        identity['config'][key] = config.get(key) or {}
    identity['config']['ArgsEscaped'] = bool(config.get('ArgsEscaped', False))
    return hashlib.sha256(json.dumps(identity, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


if __name__ == '__main__':
    images = json.load(sys.stdin)
    if not isinstance(images, list) or len(images) != 1:
        raise ValueError('Expected exactly one inspected image')
    print(image_identity(images[0]))
