/* B1 Linux-only Node-API experiment. Not linked into the converter. */
#include <node_api.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#include <errno.h>

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

NAPI_MODULE_INIT() {
  napi_value function;
  napi_create_function(env, "acquire", NAPI_AUTO_LENGTH, acquire, NULL, &function);
  napi_set_named_property(env, exports, "acquire", function);
  return exports;
}
