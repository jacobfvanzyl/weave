from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from pathlib import Path
import threading,json
class Handler(BaseHTTPRequestHandler):
 def do_GET(self):
  body=json.dumps({'ok':True,'path':self.path}).encode() if self.path.startswith('/api/') else Path(__file__).with_name('fixture.html').read_bytes()
  self.send_response(200);self.send_header('Content-Type','application/json' if self.path.startswith('/api/') else 'text/html');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
server=ThreadingHTTPServer(('127.0.0.1',19380),Handler)
threading.Timer(600,server.shutdown).start()
server.serve_forever()
