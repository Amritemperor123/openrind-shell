#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/openat2.h>
#include <linux/magic.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/statfs.h>
#include <sys/syscall.h>
#include <unistd.h>

/* Disposable risk probe: one-component destinations under a real FUSE root.
 * No overwrite, symlinks, magic links, traversal, or filesystem fallback. */
static int confined(int dir, const char *name, int flags, int mode) {
  struct open_how how = { .flags = (unsigned long long)flags,
    .mode = (unsigned long long)mode,
    .resolve = RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS };
  return syscall(SYS_openat2, dir, name, &how, sizeof(how));
}
static int valid(const char *s) {
  if (!*s || strlen(s) > 160 || !strcmp(s,".") || !strcmp(s,"..")) return 0;
  for (; *s; s++) if (!((*s >= 'a' && *s <= 'z') || (*s >= '0' && *s <= '9') || *s == '-' || *s == '.')) return 0;
  return 1;
}
int main(int argc, char **argv) {
  if (argc != 4 || !valid(argv[2]) || !valid(argv[3])) return 2;
  int writing = !strcmp(argv[1], "write");
  if (!writing && strcmp(argv[1], "read")) return 2;
  int root = open("/sandbox/work", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  struct statfs fs;
  if (root < 0 || fstatfs(root, &fs) || fs.f_type != FUSE_SUPER_MAGIC) return 3;
  if (writing && mkdirat(root, argv[2], 0700) && errno != EEXIST) return 4;
  int dir = confined(root, argv[2], O_RDONLY | O_DIRECTORY | O_CLOEXEC, 0);
  if (dir < 0) return 5;
  int file = confined(dir, argv[3], writing ? O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC : O_RDONLY | O_CLOEXEC, writing ? 0600 : 0);
  struct stat st;
  if (file < 0 || fstat(file, &st) || !S_ISREG(st.st_mode) || st.st_nlink != 1) return 6;
  char buffer[65536]; size_t total = 0; ssize_t count;
  while ((count = read(writing ? STDIN_FILENO : file, buffer, sizeof(buffer))) > 0) {
    total += (size_t)count; if (total > 8 * 1024 * 1024) return 7;
    ssize_t offset = 0;
    while (offset < count) {
      ssize_t n = write(writing ? file : STDOUT_FILENO, buffer + offset, (size_t)(count - offset));
      if (n <= 0) return 8;
      offset += n;
    }
  }
  if (count < 0 || !total) return 9;
  if (writing && (fsync(file) || fsync(dir) || fsync(root))) return 10;
  if (close(file) || close(dir) || close(root)) return 11;
  return 0;
}
