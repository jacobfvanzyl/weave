"""Private, symbol-prefixed upstream zlib-ng for the Host's RFB encoder only."""
import hashlib, json, platform, subprocess, tarfile, urllib.request
from pathlib import Path

VERSION = '2.3.3'
DIGEST = 'f9c65aa9c852eb8255b636fd9f07ce1c406f061ec19a2e7d508b318ca0c907d1'

def prepare(cache: Path, mode: str):
    options = ['-DCMAKE_BUILD_TYPE=Release', '-DCMAKE_INSTALL_LIBDIR=lib',
        '-DCMAKE_POSITION_INDEPENDENT_CODE=ON', '-DBUILD_SHARED_LIBS=OFF',
        '-DZLIB_COMPAT=ON', '-DZLIB_SYMBOL_PREFIX=weave_rfb_', '-DWITH_OPTIM=ON',
        '-DWITH_RUNTIME_CPU_DETECTION=ON', '-DWITH_NATIVE_INSTRUCTIONS=OFF',
        '-DBUILD_TESTING=ON', '-DWITH_GTEST=OFF', '-DWITH_BENCHMARKS=OFF']
    compiler = subprocess.check_output(['cc', '--version'], text=True)
    if mode == 'mac':
        sdk = subprocess.check_output(['xcrun','--sdk','macosx','--show-sdk-path'],text=True).strip()
        options += ['-DCMAKE_OSX_ARCHITECTURES=arm64', '-DCMAKE_OSX_DEPLOYMENT_TARGET=14.0', '-DCMAKE_OSX_SYSROOT='+sdk]
    key = hashlib.sha256(json.dumps([DIGEST, mode, platform.machine(), compiler, options]).encode()).hexdigest()[:16]
    base = cache / ('zlib-ng-'+VERSION)
    source, build, prefix = base/'source', base/('build-'+key), base/('install-'+key)
    archive = base/'source.tar.gz'
    base.mkdir(parents=True, exist_ok=True)
    if not archive.exists():
        pending = base/'download.tmp'
        urllib.request.urlretrieve(f'https://codeload.github.com/zlib-ng/zlib-ng/tar.gz/refs/tags/{VERSION}', pending)
        if hashlib.sha256(pending.read_bytes()).hexdigest() != DIGEST:
            pending.unlink(); raise RuntimeError('zlib-ng archive digest mismatch')
        pending.replace(archive)
    if hashlib.sha256(archive.read_bytes()).hexdigest() != DIGEST:
        raise RuntimeError('Cached zlib-ng archive digest mismatch')
    if not source.exists():
        with tarfile.open(archive) as tar:
            tar.extractall(base, filter='data')
        (base/('zlib-ng-'+VERSION)).rename(source)
    if not (prefix/'verified.json').exists():
        subprocess.run(['cmake','-S',str(source),'-B',str(build),'-DCMAKE_INSTALL_PREFIX='+str(prefix)]+options,check=True)
        subprocess.run(['cmake','--build',str(build),'--parallel','4'],check=True)
        subprocess.run(['ctest','--test-dir',str(build),'--output-on-failure'],check=True)
        subprocess.run(['cmake','--install',str(build)],check=True)
        (prefix/'verified.json').write_text(json.dumps({'version':VERSION,'sha256':DIGEST,'options':options,'compiler':compiler},indent=2))
    return prefix, key
