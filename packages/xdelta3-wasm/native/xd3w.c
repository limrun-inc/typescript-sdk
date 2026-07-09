#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "xdelta3.h"

#define XD3W_INPUT_CAP (4U * 1024U * 1024U)
#define XD3W_SOURCE_BLOCK (4U * 1024U * 1024U)
#define XD3W_SOURCE_WINDOW (64U * 1024U * 1024U)
#define XD3W_SOURCE_SLOTS 16

#define XD3W_NEED_INPUT 1
#define XD3W_HAVE_OUTPUT 2
#define XD3W_NEED_SOURCE_BLOCK 3
#define XD3W_CONTINUE 4

typedef struct xd3w_source_slot {
  int valid;
  xoff_t blkno;
  usize_t onblk;
  uint32_t last_used;
} xd3w_source_slot;

typedef struct xd3w_encoder {
  xd3_stream stream;
  xd3_config config;
  xd3_source source;
  xoff_t source_size;
  uint8_t *input_buf;
  uint8_t *source_buf;
  xd3w_source_slot source_slots[XD3W_SOURCE_SLOTS];
  uint32_t source_clock;
  int pending_slot;
  xoff_t pending_blkno;
  const char *last_msg;
  int last_ret;
} xd3w_encoder;

void xd3w_free(uintptr_t handle);

static xoff_t xd3w_double_to_xoff(double value) {
  if (value <= 0) {
    return 0;
  }
  return (xoff_t)value;
}

static xoff_t xd3w_source_window(xoff_t source_size) {
  if (source_size == 0) {
    return XD3W_SOURCE_BLOCK;
  }
  if (source_size < XD3W_SOURCE_WINDOW) {
    xoff_t rounded = XD3W_SOURCE_BLOCK;
    while (rounded < source_size && rounded < XD3W_SOURCE_WINDOW) {
      rounded <<= 1;
    }
    return rounded;
  }
  return XD3W_SOURCE_WINDOW;
}

static void xd3w_set_error(xd3w_encoder *enc, int ret) {
  enc->last_ret = ret;
  enc->last_msg = enc->stream.msg != NULL ? enc->stream.msg : xd3_strerror(ret);
}

static int xd3w_getblk(xd3_stream *stream, xd3_source *source, xoff_t blkno) {
  xd3w_encoder *enc = (xd3w_encoder *)stream->opaque;
  if (enc == NULL) {
    return XD3_INVALID;
  }

  for (int i = 0; i < XD3W_SOURCE_SLOTS; i += 1) {
    xd3w_source_slot *slot = &enc->source_slots[i];
    if (slot->valid && slot->blkno == blkno) {
      slot->last_used = ++enc->source_clock;
      source->curblk = enc->source_buf + ((usize_t)i * XD3W_SOURCE_BLOCK);
      source->curblkno = slot->blkno;
      source->onblk = slot->onblk;
      return 0;
    }
  }

  int chosen = 0;
  for (int i = 0; i < XD3W_SOURCE_SLOTS; i += 1) {
    if (!enc->source_slots[i].valid) {
      chosen = i;
      goto chosen_slot;
    }
    if (enc->source_slots[i].last_used < enc->source_slots[chosen].last_used) {
      chosen = i;
    }
  }

chosen_slot:
  enc->pending_slot = chosen;
  enc->pending_blkno = blkno;
  source->getblkno = blkno;
  stream->msg = "getblk source input";
  return XD3_GETSRCBLK;
}

uintptr_t xd3w_new(double source_size_double) {
  xoff_t source_size = xd3w_double_to_xoff(source_size_double);
  xd3w_encoder *enc = (xd3w_encoder *)calloc(1, sizeof(xd3w_encoder));
  if (enc == NULL) {
    return 0;
  }

  enc->input_buf = (uint8_t *)malloc(XD3W_INPUT_CAP);
  enc->source_buf = (uint8_t *)malloc((usize_t)XD3W_SOURCE_SLOTS * XD3W_SOURCE_BLOCK);
  if (enc->input_buf == NULL || enc->source_buf == NULL) {
    free(enc->input_buf);
    free(enc->source_buf);
    free(enc);
    return 0;
  }

  xd3_init_config(&enc->config, 0);
  enc->source_size = source_size;
  enc->config.winsize = XD3W_INPUT_CAP;
  enc->config.getblk = &xd3w_getblk;
  enc->config.opaque = enc;
  enc->pending_slot = -1;

  int ret = xd3_config_stream(&enc->stream, &enc->config);
  if (ret != 0) {
    xd3w_free((uintptr_t)enc);
    return 0;
  }

  enc->source.blksize = XD3W_SOURCE_BLOCK;
  enc->source.max_winsize = xd3w_source_window(source_size);
  enc->source.curblk = NULL;
  enc->source.curblkno = (xoff_t)-1;
  enc->source.onblk = 0;

  ret = xd3_set_source_and_size(&enc->stream, &enc->source, source_size);
  if (ret != 0) {
    xd3w_free((uintptr_t)enc);
    return 0;
  }

  return (uintptr_t)enc;
}

void xd3w_free(uintptr_t handle) {
  xd3w_encoder *enc = (xd3w_encoder *)handle;
  if (enc == NULL) {
    return;
  }
  xd3_free_stream(&enc->stream);
  free(enc->input_buf);
  free(enc->source_buf);
  free(enc);
}

uintptr_t xd3w_input_buf(uintptr_t handle) {
  xd3w_encoder *enc = (xd3w_encoder *)handle;
  return enc == NULL ? 0 : (uintptr_t)enc->input_buf;
}

uintptr_t xd3w_source_ptr(uintptr_t handle) {
  xd3w_encoder *enc = (xd3w_encoder *)handle;
  if (enc == NULL || enc->pending_slot < 0 || enc->pending_slot >= XD3W_SOURCE_SLOTS) {
    return 0;
  }
  return (uintptr_t)(enc->source_buf + ((usize_t)enc->pending_slot * XD3W_SOURCE_BLOCK));
}

uint32_t xd3w_input_cap(void) {
  return XD3W_INPUT_CAP;
}

double xd3w_source_request_offset(uintptr_t handle) {
  xd3w_encoder *enc = (xd3w_encoder *)handle;
  if (enc == NULL || enc->pending_slot < 0 || enc->pending_slot >= XD3W_SOURCE_SLOTS) {
    return 0;
  }
  return (double)(enc->pending_blkno * XD3W_SOURCE_BLOCK);
}

uint32_t xd3w_source_request_len(uintptr_t handle) {
  xd3w_encoder *enc = (xd3w_encoder *)handle;
  if (enc == NULL || enc->pending_slot < 0 || enc->pending_slot >= XD3W_SOURCE_SLOTS) {
    return 0;
  }
  xoff_t offset = enc->pending_blkno * XD3W_SOURCE_BLOCK;
  if (offset >= enc->source_size) {
    return 0;
  }
  xoff_t remaining = enc->source_size - offset;
  return (uint32_t)(remaining < XD3W_SOURCE_BLOCK ? remaining : XD3W_SOURCE_BLOCK);
}

void xd3w_avail_input(uintptr_t handle, uint32_t len, int is_final) {
  xd3w_encoder *enc = (xd3w_encoder *)handle;
  if (enc == NULL) {
    return;
  }
  if (is_final) {
    xd3_set_flags(&enc->stream, enc->stream.flags | XD3_FLUSH);
  }
  xd3_avail_input(&enc->stream, enc->input_buf, (usize_t)len);
}

int xd3w_step(uintptr_t handle) {
  xd3w_encoder *enc = (xd3w_encoder *)handle;
  if (enc == NULL) {
    return XD3_INVALID;
  }

  int ret = xd3_encode_input(&enc->stream);
  switch (ret) {
    case XD3_INPUT:
      return XD3W_NEED_INPUT;
    case XD3_OUTPUT:
      return XD3W_HAVE_OUTPUT;
    case XD3_GETSRCBLK:
      return XD3W_NEED_SOURCE_BLOCK;
    case XD3_WINSTART:
    case XD3_WINFINISH:
    case 0:
      return XD3W_CONTINUE;
    default:
      xd3w_set_error(enc, ret);
      return ret;
  }
}

uintptr_t xd3w_output_ptr(uintptr_t handle) {
  xd3w_encoder *enc = (xd3w_encoder *)handle;
  return enc == NULL ? 0 : (uintptr_t)enc->stream.next_out;
}

uint32_t xd3w_output_len(uintptr_t handle) {
  xd3w_encoder *enc = (xd3w_encoder *)handle;
  return enc == NULL ? 0 : (uint32_t)enc->stream.avail_out;
}

void xd3w_consume_output(uintptr_t handle) {
  xd3w_encoder *enc = (xd3w_encoder *)handle;
  if (enc != NULL) {
    xd3_consume_output(&enc->stream);
  }
}

void xd3w_provide_source(uintptr_t handle, uint32_t onblk) {
  xd3w_encoder *enc = (xd3w_encoder *)handle;
  if (enc == NULL || enc->pending_slot < 0 || enc->pending_slot >= XD3W_SOURCE_SLOTS) {
    return;
  }
  xoff_t blkno = enc->pending_blkno;
  xd3w_source_slot *slot = &enc->source_slots[enc->pending_slot];
  slot->valid = 1;
  slot->blkno = blkno;
  slot->onblk = (usize_t)onblk;
  slot->last_used = ++enc->source_clock;
  enc->source.curblk = enc->source_buf + ((usize_t)enc->pending_slot * XD3W_SOURCE_BLOCK);
  enc->source.curblkno = blkno;
  enc->source.onblk = (usize_t)onblk;
  enc->pending_slot = -1;
}

int xd3w_close(uintptr_t handle) {
  xd3w_encoder *enc = (xd3w_encoder *)handle;
  if (enc == NULL) {
    return XD3_INVALID;
  }
  int ret = xd3_close_stream(&enc->stream);
  if (ret != 0) {
    xd3w_set_error(enc, ret);
  }
  return ret;
}

const char *xd3w_errmsg(uintptr_t handle) {
  xd3w_encoder *enc = (xd3w_encoder *)handle;
  if (enc == NULL) {
    return "invalid xdelta3 encoder handle";
  }
  if (enc->last_msg != NULL) {
    return enc->last_msg;
  }
  if (enc->stream.msg != NULL) {
    return enc->stream.msg;
  }
  return enc->last_ret == 0 ? "" : xd3_strerror(enc->last_ret);
}
