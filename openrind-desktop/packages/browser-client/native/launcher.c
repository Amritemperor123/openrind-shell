// Fixed browser MCP launcher. Keep this native parent alive for OpenShell ancestry.
#define _POSIX_C_SOURCE 200809L
#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

static volatile sig_atomic_t child_pid = -1;
static void forward(int sig) {
    int saved = errno;
    if (child_pid > 0) (void)kill((pid_t)child_pid, sig);
    errno = saved;
}

int main(int argc, char **argv) {
    (void)argv;
    if (argc != 1) { fputs("openrind browser: arguments forbidden\n", stderr); return 2; }
    // Build execve's environment from an allowlist: no NODE_OPTIONS, LD_PRELOAD,
    // model/DB credentials, user-selected code, or NO_PROXY bypass.
    const char *names[] = { "HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy",
        "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR",
        "OPENRIND_BROWSER_SERVICE_TOKEN", "OPENRIND_BROWSER_GRANT" };
    char *env[13] = { "PATH=/usr/bin:/bin", "LANG=C.UTF-8", NULL };
    size_t count = 2;
    for (size_t i = 0; i < sizeof(names) / sizeof(names[0]); i++) {
        const char *value = getenv(names[i]);
        if (!value) continue;
        if (strlen(value) > 8192) return 2;
        size_t size = strlen(names[i]) + strlen(value) + 2;
        env[count] = malloc(size);
        if (!env[count]) return 1;
        (void)snprintf(env[count++], size, "%s=%s", names[i], value);
    }
    sigset_t blocked, old;
    sigemptyset(&blocked);
    sigaddset(&blocked, SIGINT); sigaddset(&blocked, SIGTERM); sigaddset(&blocked, SIGHUP);
    if (sigprocmask(SIG_BLOCK, &blocked, &old) == -1) return 1;
    struct sigaction action = {0};
    action.sa_handler = forward; sigemptyset(&action.sa_mask);
    if (sigaction(SIGINT, &action, NULL) || sigaction(SIGTERM, &action, NULL) ||
        sigaction(SIGHUP, &action, NULL)) return 1;
    pid_t parent = getpid();
    pid_t pid = fork();
    if (pid == -1) return 1;
    if (pid == 0) {
        action.sa_handler = SIG_DFL;
        if (sigaction(SIGINT, &action, NULL) || sigaction(SIGTERM, &action, NULL) ||
            sigaction(SIGHUP, &action, NULL)) _exit(126);
        if (prctl(PR_SET_PDEATHSIG, SIGTERM) == -1 || getppid() != parent) _exit(126);
        if (sigprocmask(SIG_SETMASK, &old, NULL) == -1) _exit(126);
        char *args[] = { "/usr/bin/node", "/opt/openrind-browser/client.cjs", NULL };
        execve(args[0], args, env);
        _exit(errno == ENOENT ? 127 : 126);
    }
    child_pid = pid;
    if (sigprocmask(SIG_SETMASK, &old, NULL) == -1) { (void)kill(pid, SIGTERM); return 1; }
    int status;
    while (waitpid(pid, &status, 0) == -1) { if (errno != EINTR) return 1; }
    child_pid = -1;
    for (size_t i = 2; i < count; i++) free(env[i]);
    return WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
}
