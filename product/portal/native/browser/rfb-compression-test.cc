// Produces a continuing, small-buffer zlib stream for independent stock decoding.
#include <zlib.h>
#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <vector>
static void output(const std::vector<uint8_t>& bytes) {
  uint32_t n=bytes.size(); uint8_t size[]={uint8_t(n>>24),uint8_t(n>>16),uint8_t(n>>8),uint8_t(n)};
  if(fwrite(size,1,4,stdout)!=4 || fwrite(bytes.data(),1,n,stdout)!=n) std::abort();
}
int main() {
  z_stream stream{}; if(deflateInit(&stream,Z_DEFAULT_COMPRESSION)!=Z_OK)return 1;
  uint32_t random=42;
  for(int update=0;update<80;update++){
    std::vector<uint8_t> plain(update%4==0?7:90000+update*13),encoded;
    for(size_t i=0;i<plain.size();i++){
      random^=random<<13;random^=random>>17;random^=random<<5;
      plain[i]=update%4==1?uint8_t(random):update%4==2?uint8_t(i/64):uint8_t(i%7+update);
    }
    stream.next_in=plain.data();stream.avail_in=plain.size();
    do {
      uint8_t chunk[257];stream.next_out=chunk;stream.avail_out=sizeof(chunk);
      if(deflate(&stream,Z_SYNC_FLUSH)!=Z_OK)return 2;
      encoded.insert(encoded.end(),chunk,chunk+sizeof(chunk)-stream.avail_out);
    } while(stream.avail_in || !stream.avail_out);
    output(plain);output(encoded);
  }
  return deflateEnd(&stream)==Z_DATA_ERROR?0:3; // Deliberately unfinished, like a disconnected RFB stream.
}
