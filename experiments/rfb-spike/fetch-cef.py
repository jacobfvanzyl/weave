from pathlib import Path
import urllib.request,json,hashlib,tarfile,subprocess,shlex
r=Path(__file__).resolve().parent;b=r/'.build';pins=json.loads((b/'cef-candidate.json').read_text())
p=pins['macosarm64'];url='https://cef-builds.spotifycdn.com/'+urllib.parse.quote(p['name']);archive=b/p['name']
if not archive.exists():urllib.request.urlretrieve(url,archive)
assert hashlib.file_digest(archive.open('rb'),'sha1').hexdigest()==p['sha1']
p['sha256']=hashlib.file_digest(archive.open('rb'),'sha256').hexdigest();print('Mac archive verified',archive.stat().st_size,flush=True)
with tarfile.open(archive) as t:t.extractall(b,filter='data')
(r/'cef-pin.json').write_text(json.dumps(pins,indent=2)+'\n')
print('Mac CEF extracted',flush=True)
