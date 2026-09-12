from openswe_ext.model_policy import (
    IMPLEMENTATION_FALLBACK_MODEL_ID,
    IMPLEMENTATION_MODEL_ID,
    REVIEW_MODEL_ID,
    fallback_model_id_for,
    install_forgeflow_model_policy,
)


def test_glm_implementation_falls_back_only_to_luna() -> None:
    assert fallback_model_id_for(IMPLEMENTATION_MODEL_ID) == IMPLEMENTATION_FALLBACK_MODEL_ID
    assert fallback_model_id_for(IMPLEMENTATION_FALLBACK_MODEL_ID) is None


def test_sol_reviewer_does_not_fall_back_to_implementation_model() -> None:
    assert fallback_model_id_for(REVIEW_MODEL_ID) is None


def test_install_is_idempotent() -> None:
    install_forgeflow_model_policy()
    install_forgeflow_model_policy()
