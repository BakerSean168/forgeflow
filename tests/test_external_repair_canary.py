from forgeflow.external_repair_canary import external_repair_canary_value


def test_external_repair_canary() -> None:
    assert external_repair_canary_value() == "ready"
