local lib = import "lib.libsonnet";
local data = importstr "data.txt";
local bin = importbin "bin.dat";
{
  use_lib: lib.fn(1),
  raw: data,
  binary: bin,
}
