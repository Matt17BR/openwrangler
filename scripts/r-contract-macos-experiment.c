/* External #955 adapter experiment. No production or installed binary. */
#define _DARWIN_C_SOURCE 1
#include <errno.h>
#include <inttypes.h>
#include <libproc.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/proc.h>
#include <sys/sysctl.h>
#include <time.h>
#include <unistd.h>

struct unique_info {
  uint8_t uuid[16];
  uint64_t unique_id, parent_unique_id;
  int32_t id_version, original_parent_version;
  uint64_t reserved[2];
};
struct combined_info { struct proc_bsdinfo bsd; struct unique_info unique; };
struct record { pid_t pid; struct combined_info info; int marked; };
struct target { pid_t pid; uint64_t unique_id; uint32_t version; };
_Static_assert(sizeof(struct unique_info) == 56, "Unexpected unique identity ABI");
enum { MAX_PIDS = 4096, MAX_TARGETS = 256, MAX_METADATA = 262144 };
static const char owner_key[] = "OPEN_WRANGLER_R_CONTRACT_OWNER=";
static double started;
static size_t metadata_bytes;

static double wall_ms(void) {
  struct timespec now;
  if (clock_gettime(CLOCK_MONOTONIC, &now)) exit(2);
  return now.tv_sec * 1000.0 + now.tv_nsec / 1000000.0;
}
static double cpu_ms(void) {
  struct rusage usage;
  if (getrusage(RUSAGE_SELF, &usage)) exit(2);
  return (usage.ru_utime.tv_sec + usage.ru_stime.tv_sec) * 1000.0 +
    (usage.ru_utime.tv_usec + usage.ru_stime.tv_usec) / 1000.0;
}
static int fail(const char *message) { fprintf(stderr, "%s\n", message); return 2; }
static int bounded(void) { return wall_ms() - started <= 250; }
static int owner_valid(const char *owner) {
  size_t count = strlen(owner);
  if (!count || count > 128) return 0;
  for (size_t i = 0; i < count; i++)
    if (!((owner[i] >= '0' && owner[i] <= '9') || (owner[i] >= 'A' && owner[i] <= 'Z') ||
          (owner[i] >= 'a' && owner[i] <= 'z') || owner[i] == '-' || owner[i] == '_')) return 0;
  return 1;
}
static int number(const char *text, uint64_t maximum, uint64_t *out) {
  if (!*text) return 0;
  for (const char *p = text; *p; p++) if (*p < '0' || *p > '9') return 0;
  char *end; errno = 0;
  unsigned long long result = strtoull(text, &end, 10);
  if (errno || *end || result > maximum) return 0;
  *out = result; return 1;
}
static int identity(pid_t pid, struct combined_info *result) {
  memset(result, 0, sizeof(*result)); errno = 0;
  int size = proc_pidinfo(pid, 18, 0, result, sizeof(*result));
  if (!size && errno == ESRCH) return 0;
  if (size != (int)sizeof(*result) || result->unique.unique_id == 0 || result->bsd.pbi_pid != (uint32_t)pid) return -1;
  return result->bsd.pbi_status == SZOMB ? 0 : 1;
}
/* argc excludes argv. Remaining bounded strings are metadata, never emitted.
 * This keeps the prior primitive's explicit appended-metadata limitation. */
static int marker(pid_t pid, const char *owner, char *buffer) {
  int mib[] = {CTL_KERN, KERN_PROCARGS2, pid}; size_t size = 0;
  if (sysctl(mib, 3, NULL, &size, NULL, 0) || size <= sizeof(int) || size > MAX_METADATA) return -1;
  metadata_bytes += size;
  if (metadata_bytes > 32 * 1024 * 1024) return -1;
  if (sysctl(mib, 3, buffer, &size, NULL, 0) || size <= sizeof(int) || size > MAX_METADATA) return -1;
  int argc; memcpy(&argc, buffer, sizeof(argc));
  if (argc < 0 || (size_t)argc > size - sizeof(argc)) return -1;
  size_t offset = sizeof(argc); char *end = memchr(buffer + offset, 0, size - offset);
  if (!end) return -1;
  offset = (size_t)(end - buffer);
  while (offset < size && !buffer[offset]) offset++;
  for (int i = 0; i < argc; i++) {
    if (offset >= size || !(end = memchr(buffer + offset, 0, size - offset))) return -1;
    offset = (size_t)(end - buffer) + 1;
  }
  int keys = 0, exact = 0; size_t owner_size = strlen(owner), key_size = sizeof(owner_key) - 1;
  while (offset < size) {
    end = memchr(buffer + offset, 0, size - offset);
    if (!end) return -1;
    size_t length = (size_t)(end - (buffer + offset));
    if (length >= key_size && !memcmp(buffer + offset, owner_key, key_size)) {
      keys++;
      if (length == key_size + owner_size && !memcmp(buffer + offset + key_size, owner, owner_size)) exact++;
    }
    offset = (size_t)(end - buffer) + 1;
  }
  return keys == 1 && exact == 1;
}
static int inspect(pid_t pid, const char *owner, char *buffer, struct record *record) {
  struct combined_info before, after;
  int found = identity(pid, &before); if (found <= 0) return found;
  int marked = marker(pid, owner, buffer);
  found = identity(pid, &after); if (found <= 0) return found;
  if (before.unique.unique_id != after.unique.unique_id || before.unique.id_version != after.unique.id_version) return -1;
  record->pid = pid; record->info = after; record->marked = marked;
  return bounded() && metadata_bytes <= 32 * 1024 * 1024 ? 1 : -1;
}
static void emit(const struct record *record) {
  const struct unique_info *u = &record->info.unique;
  printf("{\"pid\":%d,\"parentPid\":%u,\"startIdentity\":\"%" PRIu64
    "\",\"parentUniqueId\":\"%" PRIu64 "\",\"idVersion\":%" PRIu32
    ",\"originalParentVersion\":%" PRIu32 ",\"marker\":%d}", record->pid,
    record->info.bsd.pbi_ppid, u->unique_id, u->parent_unique_id,
    (uint32_t)u->id_version, (uint32_t)u->original_parent_version, record->marked);
}
static int snapshot(const char *owner, pid_t selected) {
  pid_t pids[MAX_PIDS + 1]; int bytes;
  if (selected) { pids[0] = selected; bytes = sizeof(pid_t); }
  else bytes = proc_listpids(PROC_UID_ONLY, geteuid(), pids, sizeof(pids));
  if (bytes <= 0 || bytes % (int)sizeof(pid_t) || bytes >= (int)sizeof(pids)) return fail("PID enumeration refused");
  struct record *records = calloc((size_t)bytes / sizeof(pid_t), sizeof(*records)); char *buffer = malloc(MAX_METADATA);
  if (!records || !buffer) { free(records); free(buffer); return fail("allocation refused"); }
  unsigned count = 0;
  for (size_t i = 0; i < (size_t)bytes / sizeof(pid_t); i++) {
    if (!pids[i]) continue;
    if (pids[i] < 0 || !bounded()) { free(records); free(buffer); return fail("observation bound exceeded"); }
    int result = inspect(pids[i], owner, buffer, &records[count]);
    if (result < 0) { free(records); free(buffer); return fail("identity observation refused"); }
    if (result) count++;
  }
  printf("{\"records\":[");
  for (unsigned i = 0; i < count; i++) { if (i) putchar(','); emit(&records[i]); }
  printf("],\"metadataBytes\":%zu,\"wallMs\":%.6f,\"cpuMs\":%.6f}\n", metadata_bytes, wall_ms() - started, cpu_ms());
  free(records); free(buffer); return 0;
}
/* Original ownership was admitted by the tracker's exact root/lineage checks.
 * Revalidate that stable identity, then let the kernel qualify this execution.
 * 0=signaled, 1=original gone/replaced, 2=refused while still possibly live. */
static int signal_target(struct target target, int requested) {
  if (!bounded()) return 2;
  struct combined_info current; int found = identity(target.pid, &current);
  if (!found || (found == 1 && current.unique.unique_id != target.unique_id)) return 1;
  if (found < 0) return 2;
  audit_token_t token = {{0}}; token.val[5] = (uint32_t)target.pid; token.val[7] = target.version;
  int result = proc_signal_with_audittoken(&token, requested);
  if (!result) return 0;
  if (result != ESRCH) return 2;
  found = identity(target.pid, &current);
  return !found || (found == 1 && current.unique.unique_id != target.unique_id) ? 1 : 2;
}
static int preflight(void) {
  struct combined_info current, parent; struct unique_info separate;
  if (identity(getpid(), &current) != 1 ||
      proc_pidinfo(getpid(), 17, 0, &separate, sizeof(separate)) != (int)sizeof(separate) ||
      memcmp(&separate, &current.unique, sizeof(separate))) return fail("native identity ABI unavailable");
  if (identity(getppid(), &parent) != 1 || !current.unique.original_parent_version ||
      current.unique.original_parent_version != parent.unique.id_version) return fail("native original-parent capability unavailable");
  struct target self = {getpid(), current.unique.unique_id, (uint32_t)current.unique.id_version};
  struct target stale = self; stale.version++;
  if (signal_target(stale, SIGCONT) != 2 || signal_target(self, SIGCONT) != 0) return fail("native token preflight refused");
  puts("{\"capability\":\"native-identity-signal\",\"staleSelfRefusedLive\":true}"); return 0;
}
int main(int argc, char **argv) {
  started = wall_ms();
  size_t input_bytes = 0; for (int i = 0; i < argc; i++) input_bytes += strlen(argv[i]) + 1;
  if (input_bytes > 65536) return fail("input bound exceeded");
  if (argc == 2 && !strcmp(argv[1], "preflight")) return preflight();
  if (argc == 3 && !strcmp(argv[1], "scan") && owner_valid(argv[2])) return snapshot(argv[2], 0);
  if (argc == 4 && !strcmp(argv[1], "inspect") && owner_valid(argv[2])) {
    uint64_t pid; if (!number(argv[3], INT32_MAX, &pid) || !pid) return fail("invalid PID");
    return snapshot(argv[2], (pid_t)pid);
  }
  if (argc >= 6 && !strcmp(argv[1], "signal") && (argc - 3) % 3 == 0 && (argc - 3) / 3 <= MAX_TARGETS) {
    int requested = !strcmp(argv[2], "SIGINT") ? SIGINT : !strcmp(argv[2], "SIGTERM") ? SIGTERM : !strcmp(argv[2], "SIGKILL") ? SIGKILL : 0;
    if (!requested) return fail("invalid signal");
    struct target targets[MAX_TARGETS]; int count = (argc - 3) / 3;
    for (int i = 0; i < count; i++) {
      uint64_t pid, uid, version;
      if (!number(argv[3 + 3*i], INT32_MAX, &pid) || !pid || !number(argv[4 + 3*i], UINT64_MAX, &uid) || !uid ||
          !number(argv[5 + 3*i], UINT32_MAX, &version)) return fail("invalid target");
      for (int j = 0; j < i; j++) if (targets[j].pid == (pid_t)pid) return fail("duplicate target");
      targets[i] = (struct target){(pid_t)pid, uid, (uint32_t)version};
    }
    int refused = 0; printf("{\"results\":[");
    for (int i = 0; i < count; i++) {
      int result = signal_target(targets[i], requested); if (result == 2) refused = 1;
      if (i) putchar(',');
      printf("{\"pid\":%d,\"result\":%d}", targets[i].pid, result);
    }
    puts("]}"); return refused ? 3 : 0;
  }
  return fail("invalid adapter request");
}
