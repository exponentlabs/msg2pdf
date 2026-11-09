#define _GNU_SOURCE
/* Linux Node-API case ownership and no-replace package promotion. */
#include <node_api.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#include <errno.h>
#include <sys/syscall.h>
#include <linux/fs.h>

static napi_value acquire(napi_env env, napi_callback_info info) {
  napi_value args[1], result;
  size_t count = 1, length;
  char path[4096];
  napi_get_cb_info(env, info, &count, args, NULL, NULL);
  if (count != 1 || napi_get_value_string_utf8(env, args[0], path, sizeof(path), &length) != napi_ok || length >= sizeof(path) - 1) {
    napi_throw_error(env, "CASE_LOCK_UNAVAILABLE", "Invalid lock path");
    return NULL;
  }
  int fd = open(path, O_CREAT | O_RDWR | O_CLOEXEC | O_NOFOLLOW, 0600);
  if (fd < 0) {
    napi_throw_error(env, "CASE_LOCK_UNAVAILABLE", "Cannot open lock");
    return NULL;
  }
  struct stat status;
  if (fstat(fd, &status) != 0 || !S_ISREG(status.st_mode) || status.st_nlink != 1) {
    close(fd);
    napi_throw_error(env, "CASE_LOCK_UNAVAILABLE", "Lock must be a regular unaliased file");
    return NULL;
  }
  if (flock(fd, LOCK_EX | LOCK_NB) != 0) {
    int busy = errno == EWOULDBLOCK || errno == EAGAIN;
    close(fd);
    napi_throw_error(env, busy ? "CASE_BUSY" : "CASE_LOCK_UNAVAILABLE", "Cannot acquire lock");
    return NULL;
  }
  napi_create_int32(env, fd, &result);
  return result;
}

static napi_value promote(napi_env env, napi_callback_info info) {
  napi_value args[2], result;
  size_t count = 2, first, second;
  char source[4096], target[4096];
  napi_get_cb_info(env, info, &count, args, NULL, NULL);
  if (count != 2 || napi_get_value_string_utf8(env, args[0], source, sizeof(source), &first) != napi_ok || napi_get_value_string_utf8(env, args[1], target, sizeof(target), &second) != napi_ok || first >= sizeof(source) - 1 || second >= sizeof(target) - 1) {
    napi_throw_error(env, "CASE_PUBLICATION_FAILED", "Invalid package path");
    return NULL;
  }
  if (syscall(SYS_renameat2, AT_FDCWD, source, AT_FDCWD, target, RENAME_NOREPLACE) != 0) {
    napi_throw_error(env, errno == EEXIST ? "RELEASE_EXISTS" : "CASE_PUBLICATION_FAILED", "Package promotion failed");
    return NULL;
  }
  napi_get_undefined(env, &result);
  return result;
}

NAPI_MODULE_INIT() {
  napi_value function;
  napi_create_function(env, "acquire", NAPI_AUTO_LENGTH, acquire, NULL, &function);
  napi_set_named_property(env, exports, "acquire", function);
  napi_create_function(env, "promoteDirectory", NAPI_AUTO_LENGTH, promote, NULL, &function);
  napi_set_named_property(env, exports, "promoteDirectory", function);
  return exports;
}
