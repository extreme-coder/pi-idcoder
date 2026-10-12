"""Regenerates the reference fixtures that pin this port to its oracles.

    python3 test/fixtures/reference/generate.py /path/to/Thematic_Analysis_Main

Needs numpy, scikit-learn, and krippendorff. Outputs (next to this file):
  sklearn.json          silhouette_score and KMeans inertia references
  krippendorff.json     Krippendorff (2011) worked example + random cases
  prompts.json          every prompt template rendered by the original Python functions
  format_codebook.json  reclassify_pipeline.format_codebook at each detail level
"""

import importlib.util
import json
import sys
import tempfile
import types
from pathlib import Path

import krippendorff
import numpy as np
from sklearn.cluster import KMeans
from sklearn.datasets import make_blobs
from sklearn.metrics import silhouette_score

OUT = Path(__file__).resolve().parent
REPO = Path(sys.argv[1]).resolve()


def load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def to_json_rows(matrix):
    return [[None if np.isnan(x) else int(x) for x in row] for row in matrix]


def sklearn_fixture():
    rng = np.random.default_rng(7)
    x = rng.normal(size=(40, 6))
    cases = []
    for k in (2, 3, 5):
        labels = rng.integers(0, k, size=40)
        cases.append({"labels": labels.tolist(), "score": float(silhouette_score(x, labels))})
    x2, y2 = make_blobs(n_samples=90, centers=4, n_features=5, cluster_std=0.6, random_state=3)
    km = KMeans(n_clusters=4, n_init=10, random_state=0).fit(x2)
    by_k = {k: float(silhouette_score(x2, KMeans(n_clusters=k, n_init=10, random_state=0).fit_predict(x2))) for k in range(2, 8)}
    return {
        "silhouette": {"X": x.tolist(), "cases": cases},
        "blobs": {"X": x2.tolist(), "y": y2.tolist(), "inertia": float(km.inertia_), "silhouette_by_k": by_k},
    }


def krippendorff_fixture():
    nan = np.nan
    paper = [
        [1, 2, 3, 3, 2, 1, 4, 1, 2, nan, nan, nan],
        [1, 2, 3, 3, 2, 2, 4, 1, 2, 5, nan, 3],
        [nan, 3, 3, 3, 2, 3, 4, 2, 2, 5, 1, nan],
        [1, 2, 3, 3, 2, 4, 4, 1, 2, 5, 1, nan],
    ]
    rng = np.random.default_rng(3)
    cases = []
    for coders, units, cats, missing in [(2, 30, 3, 0.0), (5, 50, 4, 0.2), (3, 12, 6, 0.3), (2, 200, 5, 0.1)]:
        data = rng.integers(0, cats, size=(coders, units)).astype(float)
        data[1:, : units // 2] = data[0, : units // 2]
        data[rng.random(size=data.shape) < missing] = nan
        cases.append({"data": to_json_rows(data), "alpha": float(krippendorff.alpha(reliability_data=data, level_of_measurement="nominal"))})
    alpha = float(krippendorff.alpha(reliability_data=paper, level_of_measurement="nominal"))
    return {"paper": {"data": to_json_rows(np.array(paper, dtype=float)), "alpha": alpha}, "cases": cases}


def extract_blocks(path: Path, marker: str):
    source = path.read_text()
    blocks, i = [], 0
    while (i := source.find(marker, i)) >= 0:
        j = source.index("(", i)
        depth = 0
        for k in range(j, len(source)):
            depth += {"(": 1, ")": -1}.get(source[k], 0)
            if depth == 0:
                break
        blocks.append(source[j : k + 1])
        i = k
    return blocks


def prompts_fixture():
    prompts = load("prompts", REPO / "agents/core/prompts.py")
    reclassify = load("prompts_reclassify", REPO / "evaluation/prompts_reclassify.py")
    judge = load("prompts_judge", REPO / "evaluation/judge_reclassify_disagreements/prompts_judge.py")
    helpers_src = (REPO / "agents/core/pipeline_helpers.py").read_text()
    namespace = {}
    exec("from typing import List\n" + helpers_src[helpers_src.index("def assign_codes_to_subthemes_prompt") :], namespace)
    rq = "What frustrates players?"
    out = {
        "open_coding": prompts.open_coding_prompt(rq, "The game lags."),
        "open_coding_feedback": prompts.open_coding_prompt(rq, "The game lags.", validator_feedback="FAIL\n- vague"),
        "validate": prompts.validate_open_codes_prompt(rq, "The game lags.", "- Code: lag"),
        "llm_clustering": prompts.llm_clustering_prompt(rq),
        "llm_clustering_empty": prompts.llm_clustering_prompt("  "),
        "high_level": prompts.high_level_code_generation_prompt("- a\n- b", rq),
        "high_level_no_rq": prompts.high_level_code_generation_prompt("- a", ""),
        "synthesis": prompts.high_level_synthesis_prompt(["L1", "L2"], rq),
        "refine": prompts.refine_cluster_assignments_prompt("Lag", "- a\n- b", "Price, Story"),
        "meta": prompts.meta_theme_grouping_prompt('{"0": "Lag"}', rq),
        "subtheme": prompts.intra_cluster_subtheme_prompt("Lag", "- a\n- b", rq),
        "bucket": prompts.hierarchy_refine_bucket_prompt("Lag", "Bucket", "- a", rq, 3),
        "report": prompts.research_report_prompt(rq, "GRAPH"),
        "assign": namespace["assign_codes_to_subthemes_prompt"]("Lag", ["S1", "S2"], ["a", "b"], rq),
        "recode_system_full": reclassify.reclassify_system("full"),
        "recode_system_theme_only_reasoning": reclassify.reclassify_system("theme_only", include_reasoning=True),
        "recode_user_full": reclassify.reclassify_user("[A] LABEL: X", '1. "q"', "full"),
        "recode_user_def_reasoning": reclassify.reclassify_user("[A] LABEL: X", '1. "q"', "theme_def", include_reasoning=True),
        "judge_system": judge.JUDGE_SYSTEM,
        "judge_user": judge.build_user_prompt(
            [
                {
                    "quote": "q1",
                    "option_a": {"label": "A", "definition": "dA", "inclusion": ["i1"], "exclusion": []},
                    "option_b": {"label": "B", "definition": "dB", "inclusion": [], "exclusion": ["e1"]},
                }
            ]
        ),
    }
    env = dict(
        label="Lag", codes_text="- [LC001] a", codes=["a", "b"], all_labels="- [LC001] a\n- [LC002] b", BATCH_SIZE=20,
        partial_block="\n[Batch 1/1]\nDefinition notes: x\n", name="Dim", available_ids="CL00, CL01",
        all_ids_text="CL00, CL01, CL02", quotes_only_text='- [CL00]\n  [QUOTE] "q"',
        neighbor_quotes_text='- [CL02]\n  [QUOTE] "n"', bad_ids={"LC009", "LC010"}, base_prompt="BASE",
        code_evidence={}, code_notes={}, code_to_id={}, batches=[1], len=len,
        _build_codes_text=lambda *a, **k: "- [LC001] a",
    )
    codebook_blocks = extract_blocks(REPO / "agents/core/codebook_enrichment.py", "prompt = (")
    env["valid_ids_str"] = "LC001"
    out["codebook_batch"] = eval(codebook_blocks[0], env)
    env["valid_ids_str"] = "LC001, LC002"
    out["codebook_single"] = eval(codebook_blocks[1], env)
    out["codebook_synthesis"] = eval(codebook_blocks[2], env)
    out["codebook_retry_suffix"] = eval(extract_blocks(REPO / "agents/core/codebook_enrichment.py", "retry_suffix = (")[0], env)
    out["dimension_sampled"] = eval(extract_blocks(REPO / "agents/core/enrich_dimensions.py", "base_prompt = (")[0], env)
    out["dimension_full"] = eval(extract_blocks(REPO / "agents/scripts/enrich_dimensions_full_evidence.py", "base_prompt = (")[0], env)
    env["bad_ids"] = {"CL09", "CL10"}
    out["dimension_retry"] = eval(extract_blocks(REPO / "agents/core/enrich_dimensions.py", "retry_prompt = (")[0], env)
    return out


def format_codebook_fixture():
    sys.modules["evaluation"] = types.ModuleType("evaluation")
    sys.modules["evaluation.llm_client"] = types.SimpleNamespace(call_llm=None, parse_json_response=None)
    sys.modules["evaluation.prompts_reclassify"] = types.SimpleNamespace(reclassify_system=None, reclassify_user=None)
    pipeline = load("evaluation.reclassify_pipeline", REPO / "evaluation/reclassify_pipeline.py")
    run_dir = Path(tempfile.mkdtemp())
    (run_dir / "data").mkdir()
    entries = [
        {
            "label": "Performance",
            "definition": "Speed issues.",
            "inclusion": [{"criterion": "Mentions lag.", "code_ids": ["CL00"], "examples": ["x"]}],
            "exclusion": [{"criterion": "Not price.", "code_ids": ["CL01"]}],
            "cluster_ids": ["0"],
        },
        {"label": "Monetization", "definition": "Prices.", "inclusion": [], "exclusion": [], "cluster_ids": ["1"]},
    ]
    (run_dir / "data" / "gt_meta_themes_enriched.json").write_text(json.dumps({"meta_themes_enriched": entries}))
    out = {"entries": entries}
    for level in ("theme_only", "theme_def", "full"):
        out[level] = pipeline.format_codebook(run_dir, detail_level=level)[0]
    return out


if __name__ == "__main__":
    for name, build in [
        ("sklearn.json", sklearn_fixture),
        ("krippendorff.json", krippendorff_fixture),
        ("prompts.json", prompts_fixture),
        ("format_codebook.json", format_codebook_fixture),
    ]:
        indent = 1 if name in ("prompts.json", "format_codebook.json") else None
        (OUT / name).write_text(json.dumps(build(), indent=indent, ensure_ascii=False))
        print(f"wrote {name}")
