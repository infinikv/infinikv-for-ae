from infinikv.third_pkg.llm_viewer.model_analyzer import ModelAnalyzer, system_info

analyzer = ModelAnalyzer(model_id="Llama-3.1-8B-Instruct", hardware="nvidia_H100", 
                                            system_info=system_info(
                                                w_bit=16,
                                                a_bit=16,
                                                kv_bit=16,
                                                tp_size=1),
                                            source="Llama")