"""
What one OCR run did, for POST_FG's logs (2026-11-05): the stage it reached (so a failure says WHERE it failed), the
page decisions (which pages were read, blank, scanned), the path taken (text layer / Textract / vision) and every paid
call (model tokens + cost, Textract pages + cost). run_po.py resets it before a run and returns summary() in its JSON,
on success AND on failure (a run that fails after its model calls was still paid for).

Prices are the ones each pipeline already uses for its cost printout (Mumbai on-demand, USD); they travel with the
summary so a cost can be re-worked if prices change.
"""

_RUN = {}


def reset():
    _RUN.clear()
    _RUN.update(stage="start", notes={}, calls=[], textract=[])


def stage(name: str):
    """The step now running: text layer, tables, textract, header, line items, totals ..."""
    _RUN["stage"] = name


def note(key: str, value):
    """A decision worth logging (pages read, table source, header mode ...)."""
    _RUN.setdefault("notes", {})[key] = value


def add_call(label: str, model: str, input_tokens: int, output_tokens: int, cost: float,
             input_price_per_m: float, output_price_per_m: float):
    _RUN.setdefault("calls", []).append({
        "label": label, "model": model, "input_tokens": int(input_tokens or 0), "output_tokens": int(output_tokens or 0),
        "cost_usd": round(float(cost or 0), 6),
        "price_per_m_usd": {"input": input_price_per_m, "output": output_price_per_m},
    })


def add_textract(pages: int, cost: float, price_per_page: float):
    _RUN.setdefault("textract", []).append({"pages": int(pages or 0), "cost_usd": round(float(cost or 0), 6),
                                           "price_per_page_usd": price_per_page})


def summary() -> dict:
    calls = _RUN.get("calls", [])
    textract = _RUN.get("textract", [])
    model_cost = sum(c["cost_usd"] for c in calls)
    textract_cost = sum(t["cost_usd"] for t in textract)
    return {
        "stage": _RUN.get("stage", "start"),
        "notes": _RUN.get("notes", {}),
        "calls": calls,
        "textract": textract,
        "totals": {
            "model_calls": len(calls),
            "input_tokens": sum(c["input_tokens"] for c in calls),
            "output_tokens": sum(c["output_tokens"] for c in calls),
            "textract_pages": sum(t["pages"] for t in textract),
            "model_cost_usd": round(model_cost, 6),
            "textract_cost_usd": round(textract_cost, 6),
            "cost_usd": round(model_cost + textract_cost, 6),
        },
    }


reset()
